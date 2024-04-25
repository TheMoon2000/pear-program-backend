import { WebSocket, WebSocketServer } from "ws"
import url from 'url';
import { getConnection, makeQuery } from "./utils/database";
import { ChatMessage } from "./constants";

const chatServer = new WebSocketServer({ port: 4010, path: "/socket", clientTracking: false, maxPayload: 1048576 })
const socketMap = new Map<string, Set<WebSocket>>()

const sqlConnection = getConnection(Infinity)

async function sql(query: string, params?: any[]) {
    const connection = await getConnection()
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

    let history: ChatMessage[] | undefined = undefined
    
    sql("SELECT chat_history FROM Rooms WHERE id = ?", [roomId]).then((room => {
        if (room.length === 0) {
            return ws.close(4004, "Did not find room id")
        }
        history = room[0].chat_history ?? []
        if (!socketMap.has(roomId)) {
            socketMap.set(roomId, new Set())
        }

        socketMap.get(roomId)?.add(ws)
        ws.send(JSON.stringify(history))
    }))

    ws.on("message", (data: Buffer, isBinary) => {
        if (isBinary) {
            return ws.close(4000, "This socket not accept binary data!")
        } else if (!email) {
            return ws.close(4000, "Visitors cannot send messages!")
        } else if (!history) {
            return ws.send(JSON.stringify({ event: "error", message: "Chat room not ready." }))
        }
        try {
            const rawMessage = JSON.parse(data.toString())
            /* Check */
            const action = rawMessage.action as string
            if (typeof action !== "string") {
                ws.close(4000, "Must provide 'action' in body")
            }
            
            if (action === "start_typing" || action === "stop_typing") {
                return ws.send(JSON.stringify({ sender: email, event: action }))
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
                    timestamp: new Date().toISOString(),
                    message_id: history.length
                }
                history.push(message)
                socketMap.get(roomId)?.forEach(roomWs => {
                    roomWs.send(JSON.stringify({...message, event: "send_message"}))
                })
                sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(history), roomId]).catch(() => {
                    socketMap.get(roomId)?.forEach(roomWs => {
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
                console.log(history[messageId])
                if (history[messageId]?.content[contentIndex]?.value[choiceIndex] === undefined) {
                    return ws.close(4000, "A combination of `message_id`, `content_index`, and `choice_index` is invalid.")
                }
                history[messageId].content[contentIndex].choice_index = choiceIndex
                socketMap.get(roomId)?.forEach(roomWs => {
                    roomWs.send(JSON.stringify({
                        sender: email,
                        event: "make_choice",
                        message_id: messageId,
                        content_index: contentIndex,
                        choice_index: choiceIndex
                    }))
                })
                sql("UPDATE Rooms SET chat_history = ? WHERE id = ?", [JSON.stringify(history), roomId]).catch(() => {
                    socketMap.get(roomId)?.forEach(roomWs => {
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
        socketMap.get(roomId)?.delete(ws)
        console.log(`socket closed with code ${code} and reason ${reason}`);
    })
})
