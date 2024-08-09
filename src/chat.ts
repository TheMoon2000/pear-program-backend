import { WebSocket, WebSocketServer } from "ws"
import url from 'url';
import { getConnection, makeQuery } from "./utils/database";
import { ChatMessage, ParticipantInfo, zoomInstance } from "./constants";
import semaphore, { Semaphore } from "semaphore";
import Bruno from "./bruno";
import { Mutex } from "async-mutex";
import { ACTIVE_PARTICIPANTS, ACTIVE_MEETINGS, ZOOM_HOSTS } from "./zoom_participants";
import { IDLE_WAIT_TIMEOUT, meetingCloseTimeouts } from "./routes/webhooks";
import { getZoomAccessToken } from "./routes/rooms";

const chatServer = new WebSocketServer({ port: 4010, path: "/socket", clientTracking: false, maxPayload: 1048576 })
export const socketMap = new Map<string, {connections: Set<WebSocket>, history: ChatMessage[], ai: Bruno, lock: Mutex}>()
const identityMap = new Map<WebSocket, {name: string, email: string}>()

export const roomMembershipMutex = new Mutex()

async function getMembersInRoom(roomId: string) {
    let members: Map<string, {count: number, name: string}> = new Map()
    await roomMembershipMutex.acquire()
    socketMap.get(roomId)?.connections.forEach(socket => {
        const result = identityMap.get(socket)
        if (result) {
            if (members.has(result.email)) {
                members.get(result.email)!.count += 1
            } else {
                members.set(result.email, { count: 1, name: result.name })
            }
        }
    })
    roomMembershipMutex.release()
    return members
}

async function sql(query: string, params?: any[]) {
    const connection = await getConnection()
    const returnValue = (await makeQuery(connection, query, params))[0]
    connection.release()
    return returnValue
}

chatServer.on("connection", (ws, request) => {
    console.log(`Received connection from ${request.socket.remoteAddress}:${request.socket.remotePort}`);
    const query = url.parse(request.url ?? '', true).query;
    const roomId = query.room_id as string
    const email = query.email as string
    if (!roomId || typeof email !== "string") {
        return ws.close(4000, "Must provide room_id and email in query parameter")
    }

    roomMembershipMutex.runExclusive(async () => {
        const room = await sql("SELECT chat_history, `condition`, bruno_state, meeting_host, zoom_meeting_id, meeting_expired FROM Rooms WHERE id = ?", [roomId])
        if (room.length === 0) {
            return ws.close(4004, "Did not find room id")
        }
        const history = room[0].chat_history ?? []
        const condition = room[0].condition as number
        const meetingHost: string | undefined = room[0].meeting_expired ? undefined : room[0].meeting_host
        const meetingId: string | undefined = room[0].meeting_expired ? undefined : room[0].zoom_meeting_id
        const brunoState = room[0].bruno_state
            
        ws.send(JSON.stringify(history))

        let bruno = socketMap.get(roomId)?.ai ?? new Bruno(roomId, condition, history, async (message) => {
            const roomInfo = socketMap.get(roomId)
            if (!roomInfo) { return -1 }

            let message_id = -1

            await roomInfo.lock.runExclusive(async () => {
                message_id = roomInfo.history.length
                const fullMessage: ChatMessage = {
                    message_id,
                    sender: "AI",
                    name: "Bruno",
                    content: message,
                    timestamp: new Date().toISOString()
                }
                roomInfo.history.push(fullMessage)
                
                await Promise.all(Array.from(socketMap.get(roomId)?.connections ?? []).map(roomWs => {
                    return new Promise((r, _) => {
                        roomWs.send(JSON.stringify(fullMessage), r)
                    })
                }))
            })

            await sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(roomInfo.history), roomId]).catch(() => {
                socketMap.get(roomId)?.connections.forEach(roomWs => {
                    roomWs.close(4000, "Chat room is not writable.")
                })
            })
            
            return message_id
        }, async (startTyping: boolean) => {
            socketMap.get(roomId)?.connections.forEach(roomWs => {
                return roomWs.send(JSON.stringify({ sender: "AI", name: "Bruno", event: startTyping ? "start_typing" : "stop_typing" }))
            })
        }, meetingHost, meetingId, brunoState)

        if (!socketMap.has(roomId)) {
            socketMap.set(roomId, {
                connections: new Set([ws]),
                history: history,
                ai: bruno,
                lock: new Mutex()
            })
        } else {
            socketMap.get(roomId)!.connections.add(ws)
            socketMap.get(roomId)!.history = history // replace room info with newest chat history
        }
        
        const participants = await sql("SELECT user_email, joined_date, Users.name, role FROM Participants INNER JOIN Users ON Users.email = Participants.user_email WHERE room_id = ? ORDER BY joined_date", [roomId])

        const activeEmails = Array.from(identityMap.values()).map(v => v.email)
        const currentParticipants: ParticipantInfo[] = participants.map((p: any, i: number) => ({
            name: p.name, email: p.user_email, id: i, role: p.role,
            isOnline: p.user_email === email || activeEmails.includes(p.user_email)
        }))
        bruno.onParticipantsUpdated(currentParticipants)

        const name = await sql("SELECT name FROM Users WHERE email = ?", [email])
        if (name.length === 0 && email.length > 0) {
            return ws.close(4004, "Did not find email in database.")
        }

        identityMap.set(ws, { name: name[0]?.name ?? "Guest", email: email })

        if (name[0]?.name) {
            sendNotificationToRoom(roomId, `${name[0].name} has joined the room.`)
            sendEventOfType(roomId, "user_joined", email, { name: name[0].name })
        }

        // Count how many connects are now associated with the user
        let members: Map<string, {count: number, name: string}> = new Map()
        socketMap.get(roomId)?.connections.forEach(socket => {
            const result = identityMap.get(socket)
            if (result) {
                if (members.has(result.email)) {
                    members.get(result.email)!.count += 1
                } else {
                    members.set(result.email, { count: 1, name: result.name })
                }
            }
        })

        await sql("UPDATE Participants SET is_online = ? WHERE room_id = ? AND user_email = ?", [members.get(email)?.count ?? 1, roomId, email]).catch(err => {
            console.error(err)
        })

        if (meetingId && currentParticipants.length === 1 && email === currentParticipants[0].email && meetingCloseTimeouts.has(meetingId)) {
            clearTimeout(meetingCloseTimeouts.get(meetingId))
            meetingCloseTimeouts.delete(meetingId)
            console.log(`Canceled countdown for closing meeting ${meetingId} since user joined back the PearProgram session within ${IDLE_WAIT_TIMEOUT}s`)
        }
    })

    ws.on("message", (data: Buffer, isBinary) => {
        if (isBinary) {
            return ws.close(4000, "This socket not accept binary data!")
        } else if (!email) {
            return ws.close(4000, "Visitors cannot send messages!")
        }

        const roomInfo = socketMap.get(roomId)!
        const history = roomInfo.history

        try {
            const rawMessage = JSON.parse(data.toString())
            /* Check */
            const action = rawMessage.action as string
            if (typeof action !== "string") {
                ws.close(4000, "Must provide 'action' in body")
            }
            
            if (action === "start_typing" || action === "stop_typing") {
                socketMap.get(roomId)?.connections.forEach(roomWs => {
                    if (roomWs !== ws) {
                        return roomWs.send(JSON.stringify({ sender: email, name: identityMap.get(ws)?.name, event: action }))
                    }
                })
            } else if (action === "send_text") {
                const content = rawMessage.content as string
                if (typeof content !== "string") {
                    ws.close(4000, "`send_text` action requires a `content` string field.")
                } else if (content.length > 4096) {
                    ws.close(4000, "Content length exceeded")
                }

                const message = {
                    content: [{ type: "text", value: content }] as { type: "text" | "choices", value: string }[],
                    sender: email,
                    name: identityMap.get(ws)?.name ?? "Unknown",
                    timestamp: new Date().toISOString(),
                    message_id: history.length
                }
                history.push(message)
                socketMap.get(roomId)?.connections.forEach(roomWs => {
                    roomWs.send(JSON.stringify({...message, event: "send_message"}))
                })
                sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(history), roomId]).catch(() => {
                    roomInfo.connections.forEach(roomWs => {
                        roomWs.close(4000, "Chat room is not writable.")
                    })
                })
                roomInfo.ai.onChatHistoryUpdated(history, "send_text")
            } else if (action === "make_choice") {
                const messageId = rawMessage.message_id
                const contentIndex = rawMessage.content_index
                const choiceIndex = rawMessage.choice_index as number

                if ([messageId, contentIndex, choiceIndex].some(i => !Number.isInteger(i))) {
                    return ws.close(4000, "In order to make choice, must provide integer `message_id`, `content_index`, and `choice_index`.")
                }
                if (history[messageId]?.content?.[contentIndex]?.value[choiceIndex] === undefined) {
                    return ws.close(4000, "A combination of `message_id`, `content_index`, and `choice_index` is invalid.")
                }
                history[messageId].content![contentIndex].choice_index = choiceIndex
                socketMap.get(roomId)?.connections.forEach(roomWs => {
                    roomWs.send(JSON.stringify({
                        sender: email,
                        event: "make_choice",
                        message_id: messageId,
                        content_index: contentIndex,
                        choice_index: choiceIndex
                    }))
                })
                sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(history), roomId]).catch(() => {
                    roomInfo.connections.forEach(roomWs => {
                        roomWs.close(4000, "Chat room is not writable.")
                    })
                })
                roomInfo.ai.onChatHistoryUpdated(history, "make_choice", {messageId, contentIndex, choiceIndex})
                roomInfo.ai.onUserMakesChoice(messageId, contentIndex, choiceIndex, email)
            } else {
                return ws.close(4000, `Action '${action}' is unrecognized.`)
            }
            
        } catch (error) {
            console.log(error)
            return ws.close(4000, "The message format is invalid.")
        }
    })

    ws.on("error", (err) => {
        console.log(err)
    })

    ws.on("close", (code, reason) => {
        socketMap.get(roomId)?.connections.delete(ws)
        const leftUser = identityMap.get(ws)
        identityMap.delete(ws)
        if (socketMap.get(roomId)?.connections?.size === 0) {
            socketMap.get(roomId)?.ai.onRoomClose()
            console.log(`All participants left room ${roomId}, closing...`)
            roomMembershipMutex.runExclusive(async () => {
                await sql("UPDATE Participants SET is_online = 0 WHERE room_id = ?", [roomId])
            })

            // If the zoom meeting is currently empty and no timer is set for the current room, set one
            const bruno = socketMap.get(roomId)?.ai
            const meetingId = socketMap.get(roomId)?.ai.meetingId
            const meetingHost = socketMap.get(roomId)?.ai.meetingHost
            console.log(Array.from(socketMap.keys()))
            console.log(roomId, bruno, meetingId, meetingHost, ACTIVE_PARTICIPANTS, meetingCloseTimeouts)
            if (bruno && meetingId && meetingHost && (!ACTIVE_PARTICIPANTS.has(meetingId) || ACTIVE_PARTICIPANTS.get(meetingId)?.length === 0) && !meetingCloseTimeouts.has(meetingId)) {
                meetingCloseTimeouts.set(meetingId, setTimeout(async () => {
                    bruno.meetingId = undefined
                    bruno.meetingHost = undefined

                    const accessToken = await getZoomAccessToken()
                    await zoomInstance.put(`/meetings/${meetingId}/status`, { action: "end" }, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }).catch(err => console.warn(err)) // end the meeting
                    await zoomInstance.delete(`/meetings/${meetingId}`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }).catch(err => console.warn(err)) // delete the meeting
                    
                    const conn = await getConnection()
                    await makeQuery(conn, "UPDATE Participants SET zoom_url = null WHERE room_id = ?", [roomId])
                    await makeQuery(conn, "UPDATE Rooms SET meeting_expired = 1 WHERE id = ?", [roomId])
                    conn.release()

                    // Make the host available again
                    const hostIndex = ZOOM_HOSTS.indexOf(meetingHost)
                    if (hostIndex >= 0 && ACTIVE_MEETINGS[hostIndex] === meetingId) {
                        ACTIVE_MEETINGS[hostIndex] = null
                    } else {
                        console.warn(`Host ${meetingHost} not found`)
                    }

                    socketMap.get(roomId)?.ai.send([{
                        type: "text",
                        value: "The Zoom meeting for this room has automatically closed due to inactivity. If this is unintentional, please go back to the [home page](https://pearprogram.co) and start a new session."
                    }])

                    await sendEventOfType(roomId, "zoom_expired", "", {})

                    console.log(`Auto-closed zoom meeting ${meetingId} for room ${roomId} due to abandoned session`)

                }, IDLE_WAIT_TIMEOUT * 1000))
                console.log(`Begin ${IDLE_WAIT_TIMEOUT}s meeting close countdown for room ${roomId}`)
            }
            socketMap.delete(roomId)
        } else if (leftUser?.email) {
            sql("SELECT user_email, joined_date, Users.name FROM Participants INNER JOIN Users ON Users.email = Participants.user_email WHERE room_id = ? ORDER BY joined_date", [roomId]).then(participants => {
                const activeEmails = Array.from(identityMap.values()).map(v => v.email)
                const currentParticipants: ParticipantInfo[] = participants.map((p: any, i: number) => ({
                    name: p.name, email: p.user_email, id: i,
                    isOnline: activeEmails.includes(p.user_email)
                }))
                socketMap.get(roomId)?.ai.onParticipantsUpdated(currentParticipants)
            })
            roomMembershipMutex.runExclusive(async () => {
                await sql("UPDATE Participants SET is_online = is_online - 1 WHERE room_id = ? AND user_email = ?", [roomId, email])
            })
        }

        
        if (leftUser?.email) {
            sendNotificationToRoom(roomId, `${leftUser?.name} has left the room.`)
        }

        console.log(`(socket closed with code ${code})`);
    })
})

export async function sendNotificationToRoom(roomId: string, message: string) {
    const roomInfo = socketMap.get(roomId)
    if (!roomInfo) {
        return false
    }

    await roomInfo.lock.runExclusive(async () => {
        const notification = {
            sender: "system",
            name: "System",
            message_id: roomInfo.history.length,
            system_message: message,
            timestamp: new Date().toISOString()
        }
        roomInfo.history.push(notification)
        await sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(roomInfo.history), roomId]).catch(() => {
            socketMap.get(roomId)?.connections.forEach(roomWs => {
                roomWs.close(4000, "Chat room is not writable.")
            })
        })
        roomInfo.connections.forEach(roomWs => {
            roomWs.send(JSON.stringify(notification))
        })
    })

    return true
}

export async function sendEventOfType(roomId: string, eventType: "question_update" | "autograder_update" | "terminal_started" | "update_role" | "leave_session" | "zoom_bot_joined" | "zoom_bot_left" | "user_joined" | "zoom_expired", senderEmail: string, data: Record<string, any>) {
    const roomInfo = socketMap.get(roomId)
    if (!roomInfo) {
        return false
    }

    const eventJSON = {
        sender: "system",
        event: eventType,
        ...data
    }

    // Broadcast to all users who are not the sender
    roomInfo.connections.forEach(roomWs => {
        if (identityMap.get(roomWs)?.email !== senderEmail) {
            roomWs.send(JSON.stringify(eventJSON))
        }
    })
}