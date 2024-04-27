import { WebSocket, WebSocketServer } from "ws"
import url from 'url';
import { getConnection, makeQuery } from "./utils/database";
import { ChatMessage } from "./constants";

const chatServer = new WebSocketServer({ port: 4010, path: "/socket", clientTracking: false, maxPayload: 1048576 })
const socketMap = new Map<string, {connections: Set<WebSocket>, history: ChatMessage[]}>()
const nameMap = new Map<WebSocket, string>()

const sqlConnection = getConnection(Infinity)

async function sql(query: string, params?: any[]) {
    return (await makeQuery(await sqlConnection, query, params))[0]
}

chatServer.on("connection", (ws, request) => {
    console.log(`Received connection from ${request.socket.remoteAddress}:${request.socket.remotePort}`);
    const query = url.parse(request.url ?? '', true).query;
    const roomId = query.room_id as string
    const email = query.email as string
    if (!roomId) {
        return ws.close(4000, "Must provide room_id and email in query parameter")
    }

    if (!socketMap.has(roomId)) {
        socketMap.set(roomId, {
            connections: new Set([ws]),
            history: [],
        })
    }
    
    sql("SELECT chat_history FROM Rooms WHERE id = ?", [roomId]).then((room => {
        if (room.length === 0) {
            return ws.close(4004, "Did not find room id")
        }
        const history = room[0].chat_history ?? []
        socketMap.get(roomId)!.connections.add(ws)
        socketMap.get(roomId)!.history = history // replace room info with newest chat history
        
        ws.send(JSON.stringify(history))
    }))

    sql("SELECT name FROM Users WHERE email = ?", [email]).then(name => {
        if (name.length === 0) {
            return ws.close(4004, "Did not find email in database.")
        }
        nameMap.set(ws, name[0].name)

        socketMap.get(roomId)?.connections.forEach(roomWs => {
            // if ()
            sendNotificationToRoom(roomId, `${name[0].name} has joined the room.`)
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
                    name: nameMap.get(ws),
                    timestamp: new Date().toISOString(),
                    message_id: history.length
                }
                history.push(message)
                socketMap.get(roomId)?.connections.forEach(roomWs => {
                    roomWs.send(JSON.stringify({...message, event: "send_message"}))
                })
                sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(history), roomId]).catch(() => {
                    socketMap.get(roomId)?.connections.forEach(roomWs => {
                        roomWs.close(4000, "Chat room is not writable.")
                    })
                })
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
                    socketMap.get(roomId)?.connections.forEach(roomWs => {
                        roomWs.close(4000, "Chat room is not writable.")
                    })
                })
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
        const leftUser = nameMap.get(ws)
        nameMap.delete(ws)
        sendNotificationToRoom(roomId, `${leftUser} has left the room.`)
        if (socketMap.get(roomId)?.connections?.size === 0) {
            socketMap.delete(roomId)
            console.log(`All participants left room ${roomId}, closing...`)
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