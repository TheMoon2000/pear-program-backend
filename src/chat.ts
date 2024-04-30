import { WebSocket, WebSocketServer } from "ws"
import url from 'url';
import { getConnection, makeQuery } from "./utils/database";
import { ChatMessage, ParticipantInfo } from "./constants";
import Bruno from "./bruno";

const chatServer = new WebSocketServer({ port: 4010, path: "/socket", clientTracking: false, maxPayload: 1048576 })
const socketMap = new Map<string, {connections: Set<WebSocket>, history: ChatMessage[], ai: Bruno}>()
const identityMap = new Map<WebSocket, {name: string, email: string}>()

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

    const chatHistoryPromise = new Promise<Bruno>((r, _) => {
        sql("SELECT chat_history FROM Rooms WHERE id = ?", [roomId]).then((room => {
            if (room.length === 0) {
                return ws.close(4004, "Did not find room id")
            }
            const history = room[0].chat_history ?? []
            
            ws.send(JSON.stringify(history))

            const bruno = new Bruno(roomId, history, async (message) => {
                const roomInfo = socketMap.get(roomId)
                if (!roomInfo) { return }

                const fullMessage: ChatMessage = {
                    message_id: roomInfo.history.length,
                    sender: "AI",
                    content: message,
                    timestamp: new Date().toISOString()
                }
                roomInfo.history.push(fullMessage)

                await Promise.all(Array.from(socketMap.get(roomId)?.connections ?? []).map(roomWs => {
                    return new Promise((r, _) => {
                        roomWs.send(JSON.stringify(fullMessage), r)
                    })
                }))

                await sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(roomInfo.history), roomId]).catch(() => {
                    socketMap.get(roomId)?.connections.forEach(roomWs => {
                        roomWs.close(4000, "Chat room is not writable.")
                    })
                })
            })

            if (!socketMap.has(roomId)) {
                socketMap.set(roomId, {
                    connections: new Set([ws]),
                    history: history,
                    ai: bruno
                })
            } else {
                socketMap.get(roomId)!.connections.add(ws)
                socketMap.get(roomId)!.history = history // replace room info with newest chat history
            }
            r(bruno)
        }))
    })

    sql("SELECT name FROM Users WHERE email = ?", [email]).then(name => {
        if (name.length === 0 && email.length > 0) {
            return ws.close(4004, "Did not find email in database.")
        }

        identityMap.set(ws, { name: name[0]?.name ?? "Guest", email: email })

        if (name[0]?.name) {
            sendNotificationToRoom(roomId, `${name[0].name} has joined the room.`)
        }
    })

    chatHistoryPromise.then((bruno) => {
        sql("SELECT user_email, joined_date, Users.name FROM Participants INNER JOIN Users ON Users.email = Participants.user_email WHERE room_id = ? ORDER BY joined_date", [roomId]).then(participants => {
            const activeEmails = Array.from(identityMap.values()).map(v => v.email)
            const currentParticipants: ParticipantInfo[] = participants.map((p: any, i: number) => ({
                name: p.name, email: p.user_email, id: i,
                isOnline: p.user_email === email || activeEmails.includes(p.user_email)
            }))
            bruno.onParticipantsUpdated(currentParticipants)
        })
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
                        return roomWs.send(JSON.stringify({ sender: email, event: action }))
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
                    name: identityMap.get(ws)?.name,
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
        if (leftUser?.email) {
            sendNotificationToRoom(roomId, `${leftUser?.name} has left the room.`)
        }
        if (socketMap.get(roomId)?.connections?.size === 0) {
            socketMap.get(roomId)?.ai.onRoomClose()
            socketMap.delete(roomId)
            console.log(`All participants left room ${roomId}, closing...`)
        } else if (leftUser?.email) {
            sql("SELECT user_email, joined_date, Users.name FROM Participants INNER JOIN Users ON Users.email = Participants.user_email WHERE room_id = ? ORDER BY joined_date", [roomId]).then(participants => {
                const activeEmails = Array.from(identityMap.values()).map(v => v.email)
                const currentParticipants: ParticipantInfo[] = participants.map((p: any, i: number) => ({
                    name: p.name, email: p.user_email, id: i,
                    isOnline: activeEmails.includes(p.user_email)
                }))
                socketMap.get(roomId)?.ai.onParticipantsUpdated(currentParticipants)
            })
        }


        console.log(`(socket closed with code ${code})`);
    })
})

export async function sendNotificationToRoom(roomId: string, message: string) {
    const roomInfo = socketMap.get(roomId)
    if (!roomInfo) {
        return false
    }

    const notification = {
        sender: "system",
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
    return true
}

export async function sendEventOfType(roomId: string, eventType: "autograder_update" | "terminal_started", senderEmail: string, data: Record<string, any>) {
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