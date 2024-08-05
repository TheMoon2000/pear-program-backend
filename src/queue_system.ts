import { roomMembershipMutex, sendEventOfType, socketMap } from "./chat"
import { hubInstance, zoomInstance } from "./constants"
import { execAsync, getZoomAccessToken } from "./routes/rooms"
import { getConnection, makeQuery } from "./utils/database"
import { WebSocket, WebSocketServer } from "ws"
import url from 'url';
import fastq from "fastq"
import { v4 } from "uuid"
import { ACTIVE_MEETINGS, ZOOM_HOSTS } from "./zoom_participants"
import { meetingCloseTimeouts, UNUSED_MEETING_TIMEOUT } from "./routes/webhooks"

interface AdmitTask {
    name: string
    email: string
    socket: WebSocket
}

export const admitQueue = fastq.promise(admitIntoRoomWorker, 1)

const queueServer = new WebSocketServer({ port: 4011, path: "/socket", clientTracking: false, maxPayload: 1048576 })
queueServer.on("connection", (ws, request) => {
    console.log(`Received connection from ${request.socket.remoteAddress}:${request.socket.remotePort}`);
    const query = url.parse(request.url ?? '', true).query;
    const name = query.name as string
    const email = query.email as string

    if (admitQueue.getQueue().some(task => task.email === email)) {
        ws.close(4000, "This email is already in queue.")
    } else {
        admitQueue.push({ name, email, socket: ws })
        
        ws.send(JSON.stringify({ order: admitQueue.length() }))
    }

})

async function admitIntoRoomWorker(task: AdmitTask) {
    console.log('processing', task.email)
    // Update the order of the people still in queue
    admitQueue.getQueue().forEach((task2, i) => {
        if (task2.socket.readyState === 1 && task2.email !== task.email) {
            task2.socket.send(JSON.stringify({ order: i + 1 }))
        }
    })

    if (task.socket.readyState === WebSocket.OPEN) {
        const ws = task.socket
        const userEmail = task.email
        const username = task.name

        const zoomAccessToken = await getZoomAccessToken()

        let conn = await getConnection()
        await roomMembershipMutex.acquire()
        try {
            /* In either case, register the user first */
            await makeQuery(conn, "INSERT INTO Users (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = ?, last_participated = NOW(3)", [userEmail, username, username])

            let [halfVacantRooms] = await makeQuery(conn, "SELECT Rooms.id, Rooms.zoom_meeting_id, Rooms.meeting_host, Rooms.meeting_expired, CAST(SUM(Participants.is_online >= 1) AS UNSIGNED) AS online_count, JSON_ARRAYAGG(Participants.user_email) as email_list FROM Rooms INNER JOIN Participants ON Rooms.id = Participants.room_id WHERE Rooms.meeting_expired = 0 GROUP BY 1,2,3,4 ORDER BY creation_date")

            halfVacantRooms = halfVacantRooms.filter((room: any) => room.email_list.length < 2)
            const activeRooms: Array<any> = halfVacantRooms.filter((room: any) => room.online_count > 0)

            console.log('active rooms', activeRooms)

            // Case 1: user has been waiting by themselves alone in a room. Get them there
            let occupiedRoom = (halfVacantRooms as Array<any>).find(room => room.email_list.length === 1 && room.email_list[0] === userEmail)
            if (occupiedRoom) {
                console.log(`Directing ${userEmail} to the room they opened themselves (${occupiedRoom.id})`)
                ws.send(JSON.stringify({
                    room_id: occupiedRoom.id,
                    is_new_room: false,
                    already_in_room: true
                }))
                return ws.close(1000, `Successfully returned to existing room ${occupiedRoom.id}`)
            // Case 2: another user is online and waiting by themselves in a room (hence email_list.length == 1). Assign this user to the room.
            } else if (activeRooms.length > 0) {
                console.log(`Assigning ${userEmail} to available room with ${activeRooms[0].email_list[0]}`)
                
                // obtain the name of the existing user
                const [existingUsername] = await makeQuery(conn, "SELECT name FROM Users WHERE email = ?", [activeRooms[0].email_list[0]])


                // Insert participant into zoom meeting by adding them as registrant
                const addRegistrantResponse = await zoomInstance.post(`/meetings/${activeRooms[0].zoom_meeting_id}/registrants`, {
                    first_name: username,
                    last_name: existingUsername[0] === username ? "2" : "1",
                    email: `user2-${activeRooms[0].zoom_meeting_id}@pearprogram.co`
                }, {
                    headers: { Authorization: `Bearer ${zoomAccessToken}` }
                })

                await makeQuery(conn, "INSERT INTO Participants (room_id, user_email, zoom_url, zoom_registrant_id, is_online) VALUES (?, ?, ?, ?, 1)", [activeRooms[0].id, userEmail, addRegistrantResponse.data.join_url, addRegistrantResponse.data.registrant_id])

                /* Update room to full */
                await makeQuery(conn, "UPDATE Rooms SET is_full = 1 WHERE id = ?", [activeRooms[0].id])

                ws.send(JSON.stringify({
                    room_id: activeRooms[0].id,
                    is_new_room: false,
                    already_in_room: false
                }))
                ws.close(1000, `Successfully joined existing room ${activeRooms[0].id}`)

                // Start the idle meeting timer
                const meetingId = activeRooms[0].zoom_meeting_id as string
                clearTimeout(meetingCloseTimeouts.get(`${meetingId}`))
                meetingCloseTimeouts.set(`${meetingId}`, setTimeout(async () => {
                    const bruno = socketMap.get(activeRooms[0].id)?.ai
                    if (bruno) {
                        bruno.meetingHost = undefined
                        bruno.meetingId = undefined
                    }

                    const accessToken = await getZoomAccessToken()
                    await zoomInstance.put(`/meetings/${meetingId}/status`, { action: "end" }, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }).catch(err => console.warn(err)) // end the meeting
                    await zoomInstance.delete(`/meetings/${meetingId}`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }).catch(err => console.warn(err)) // delete the meeting
                    
                    const conn = await getConnection()
                    await makeQuery(conn, "UPDATE Participants SET zoom_url = null WHERE room_id = ?", [activeRooms[0].id])
                    await makeQuery(conn, "UPDATE Rooms SET meeting_expired = 1 WHERE id = ?", [activeRooms[0].id])
                    conn.release()

                    // Make the host available again
                    const hostIndex = ZOOM_HOSTS.indexOf(activeRooms[0].meeting_host)
                    if (hostIndex >= 0 && ACTIVE_MEETINGS[hostIndex] === meetingId) {
                        ACTIVE_MEETINGS[hostIndex] = null
                    } else {
                        console.warn(`Host ${activeRooms[0].meeting_host} not found`)
                    }

                    socketMap.get(activeRooms[0].id)?.ai.send([{
                        type: "text",
                        value: "The Zoom meeting for this room has automatically closed due to inactivity. If this is unintentional, please go back to the [home page](https://pearprogram.co) and start a new session."
                    }])

                    await sendEventOfType(activeRooms[0].id, "zoom_expired", "", {})

                    console.log(`Auto-closed zoom meeting ${meetingId} for room ${activeRooms[0].id}`)

                }, UNUSED_MEETING_TIMEOUT * 1000))
                console.log(`Begin ${UNUSED_MEETING_TIMEOUT}s unused countdown for room ${activeRooms[0].id} (zoom meeting id: ${meetingId})`)

                return
            }

            conn.release()
            // No vacant rooms to join. Must create a new room.
            // This means the user must wait for a vacant zoom account
            let chosenHost: string | undefined
            let hostIndex = -1
            let waitTime = 0
            while (task.socket.readyState === WebSocket.OPEN && !chosenHost) {
                for (let i = 0; i < ACTIVE_MEETINGS.length; i++) {
                    if (ACTIVE_MEETINGS[i] === null) {
                        chosenHost = ZOOM_HOSTS[i]
                        hostIndex = i 
                        break
                    }
                }
                console.log(task.email, "waiting", waitTime)
                task.socket.send(JSON.stringify({ order: 0 }))
                await new Promise((r, _) => setTimeout(r, 3000))
                waitTime += 3
            }

            if (chosenHost) {
                conn = await getConnection()
                const sessionId = v4().replace(/-/g, "");
                console.log(`Creating new room with id ${sessionId}, hosted by ${chosenHost}`)

                // Create user
                await execAsync(`docker exec env useradd ${sessionId}`)
                await execAsync(`docker exec env mkdir /home/${sessionId}`)
                await execAsync(`docker exec env chown ${sessionId}:${sessionId} /home/${sessionId}`)
                await execAsync(`docker exec env chmod 700 /home/${sessionId}`)

                await hubInstance.post(`/users/${sessionId}`)

                // Create token
                const { token: userToken } = await hubInstance.post(`/users/${sessionId}/tokens`).then(r => r.data)

                // Count the number of existing rooms
                const [roomCount] = await makeQuery(conn, "SELECT COUNT(id) as count FROM Rooms")
                const condition = roomCount[0].count % 4
                
                // Create zoom meeting
                const createMeetingResponse = await zoomInstance.post(`/users/${chosenHost}/meetings`, {
                    topic: "PearProgram session",
                    agenda: sessionId,
                    type: 2, // scheduled meeting
                    start_time: new Date().toISOString(),
                    settings: {
                        participant_video: true,
                        join_before_host: true,
                        jbh_time: 0,
                        mute_upon_entry: true,
                        registrants_confirmation_email: false,
                        approval_type: 0, // automatically approve registration
                        registrants_email_notification: false
                    }
                }, {
                    headers: { Authorization: `Bearer ${zoomAccessToken}` }
                })
                const meetingId = createMeetingResponse.data.id as number
                if (!meetingId) {
                    console.warn("Meeting not created!")
                    return ws.close(1011, "Meeting not created")
                }
                ACTIVE_MEETINGS[hostIndex] = `${meetingId}`
                console.log("created zoom meeting with id", meetingId)

                const initialCode = `print("Hello world!")`
                const initialAuthorMap = initialCode.replace(/[^\n]/g, "?")
                await makeQuery(conn, "INSERT INTO Rooms (id, code, author_map, zoom_meeting_id, jupyter_server_token, `condition`, meeting_host) VALUES (?, ?, ?, ?, ?, ?, ?)", [sessionId, initialCode, initialAuthorMap, meetingId, userToken, condition, chosenHost])

                // Insert participant into zoom meeting
                const addRegistrantResponse = await zoomInstance.post(`/meetings/${meetingId}/registrants`, {
                    first_name: username,
                    last_name: "1",
                    email: `user1-${meetingId}@pearprogram.co`
                }, {
                    headers: { Authorization: `Bearer ${zoomAccessToken}` }
                })
                console.log('registration result', addRegistrantResponse.data)
                await makeQuery(conn, "INSERT INTO Participants (room_id, user_email, zoom_url, zoom_registrant_id, is_online) VALUES (?, ?, ?, ?, 1)", [sessionId, userEmail, addRegistrantResponse.data.join_url, addRegistrantResponse.data.registrant_id])

                // Insert starter code into rustpad
                await new Promise<any>((r, _) => {
                    const roomWs = new WebSocket(`wss://rustpad.io/api/socket/${sessionId}`)
                    roomWs.once("open", () => {
                        roomWs.send(JSON.stringify({
                            Edit: { revision: 0, operation: [initialCode] }
                        }), r)
                    })
                })

                await new Promise<any>((r, _) => {
                    const authorWs = new WebSocket(`wss://rustpad.io/api/socket/${sessionId}-authors`)
                    authorWs.once("open", () => {
                        authorWs.send(JSON.stringify({
                            Edit: { revision: 0, operation: [initialAuthorMap] }
                        }), r)
                    })
                })

                ws.send(JSON.stringify({
                    room_id: sessionId,
                    existing: false,
                    already_in_room: false
                }))
                ws.close(1000, `Successfully created and joined room ${sessionId}`)
            } else {
                // The user gave up waiting and simply left the page
                console.log(`${userEmail} gave up waiting`)
                ws.close(1000, "User gave up waiting")
            }
        } catch (error) {
            console.warn(error)
            ws.close(1011, "Internal error")
        } finally {
            conn.release()
            roomMembershipMutex.release()
        }
    }
}