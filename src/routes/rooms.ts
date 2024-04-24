import { Router } from "express";
import { exec } from "child_process";
import fs from "fs";
import { authHeader, hubInstance, serverInstance } from "../constants";
import axios from "axios";
import { v4 } from "uuid";
import { makeQuery, getConnection } from "../utils/database";
import { PoolConnection } from "mysql2/promise";


const pistonInstance = axios.create({ baseURL: "http://127.0.0.1:2000/api/v2" })
const dyteInstance = axios.create({ baseURL: "https://api.dyte.io/v2", headers: { Authorization: `Basic ${process.env.DYTE_AUTH}`} })
const roomTimeouts = new Map<string, NodeJS.Timeout>();

export const roomRouter = Router()

async function execAsync(command: string) {
    return new Promise<string>((re, rj) => {
        exec(command, (err, stdout, stderr) => {
            if (err || stderr) {
                rj(err?.message || stderr)
            } else {
                re(stdout)
            }
        })
    })
}

roomRouter.get("/:room_id", async(req, res) => {
    const email = req.query.email as string | undefined;
    const conn = await getConnection();

    try {
        // Get room information
        const [room] = await makeQuery(conn, 
            "SELECT Rooms.*, test_cases FROM Rooms LEFT JOIN TestCases ON TestCases.question_id = Rooms.question_id WHERE id = ?", 
            [req.params.room_id])
        if (room.length === 0) {
            return res.status(404).send("Did not find the room with the given id")
        }

        const rustpadHistory = await axios.get(`http://rustpad.io/api/text/${req.params.room_id}`)
        const authorHistory = await axios.get(`http://rustpad.io/api/text/${req.params.room_id}-authors`)
        if (rustpadHistory.data) {
            room[0].rustpad_code = rustpadHistory.data
        }
        if (authorHistory.data) {
            room[0].rustpad_author_map = authorHistory.data
        }
        
        // Check if a server is opened
        const status = await hubInstance.get(`/users/${req.params.room_id}`).catch(err => null)

        if (status === null) {
            return res.status(404).send("Room not found.")
        }

        let terminalId = null

        if (Object.keys(status.data.servers).length > 0) {
            // A server is opened

            // Get terminal information
            const terminalInfo = await serverInstance.get(`/${req.params.room_id}/api/terminals`, { headers: authHeader }).then(r => r.data)
            terminalId = terminalInfo[0]?.name ?? null
        }


        const [selfParticipant] = await makeQuery(conn, 
            "SELECT dyte_participant_id AS participant_id, dyte_token FROM Participants WHERE room_id = ? AND user_email = ?", 
            [req.params.room_id, email])

        if (selfParticipant.length === 0) {
            selfParticipant.push({ participant_id: null, user_token: null})
        }

        const [allParticipants] = await makeQuery(conn,
            `SELECT p.dyte_participant_id AS participant_id, u.name FROM Participants p LEFT JOIN Users u ON p.user_email = u.email
            WHERE room_id = ? ORDER BY joined_date`,
            [req.params.room_id])
        
        allParticipants.forEach((item: any, i: number) => {
            item.index = i
            if (selfParticipant[0]?.participant_id === item.participant_id) {
                selfParticipant[0].index = i
            }
        })        
        
        res.status(200).json({
            room: room[0],
            server: {
                terminal_id: terminalId
            },
            author_id: selfParticipant[0].index,
            meeting: {
                meeting_id: room[0].dyte_meeting_id,
                all_participants: allParticipants,
                participant_id: selfParticipant[0]?.participant_id,
                user_token: selfParticipant[0]?.dyte_token
            }
        })
        } catch (error) {
            console.error(error)
            res.sendStatus(500);
        } finally {
            conn.release();
        }
})

/* Create a new room, or join existing room */
roomRouter.post("/", async (req, res) => {

    const userEmail = req.body?.email
    const username = req.body?.name

    try {
        if (!userEmail || !userEmail.includes("@") || !username) {
            return res.status(400).send("Must provide email and name in body.")
        }
    } catch (error) {
        return res.status(400).end("Must provide valid email.")
    }

    const conn = await getConnection()
    try {
        /* In either case, register the user first */
        await makeQuery(conn, "INSERT INTO Users (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = ?, last_participated = NOW()", [userEmail, username, username])

        const [mostRecentRoom] = await makeQuery(conn, "SELECT * FROM Rooms ORDER BY creation_date DESC LIMIT 1")

        if (mostRecentRoom.length > 0 && mostRecentRoom[0].is_full == 0) {
            console.log("Found available room:", mostRecentRoom[0].id)

            // Edge case: check if current participant is already in the room
            const [currentParticipants] = await makeQuery(conn, "SELECT * FROM Participants WHERE room_id = ? AND user_email = ?", [mostRecentRoom[0].id, userEmail])
            if (currentParticipants.length > 0) { // user must be already be waiting in a room, get them there

                return res.json({
                    room_id: mostRecentRoom[0].id,
                    is_new_room: false,
                    already_in_room: true
                })
            }
            // Insert participant into dyte meeting
            const insertionResponse = await dyteInstance.post(`/meetings/${mostRecentRoom[0].dyte_meeting_id}/participants`, {
                preset_name: "group_call_participant",
                custom_participant_id: userEmail,
                name: username
            }).then(r => r.data)

            const [insertParticipantResult] = await makeQuery(conn, "INSERT INTO Participants (room_id, user_email, dyte_token, dyte_participant_id) VALUES (?, ?, ?, ?)", [mostRecentRoom[0].id, userEmail, insertionResponse.data.token, insertionResponse.data.id])

            /* Update room to full */
            await makeQuery(conn, "UPDATE Rooms SET is_full = 1 WHERE id = ?", [mostRecentRoom[0].id])

            return res.json({
                room_id: mostRecentRoom[0].id,
                is_new_room: false,
                already_in_room: false
            })
        }

        const sessionId = v4().replace(/-/g, "");

        // Create user
        await execAsync(`docker exec env useradd ${sessionId}`)
        await execAsync(`docker exec env mkdir /home/${sessionId}`)
        await execAsync(`docker exec env chown ${sessionId}:${sessionId} /home/${sessionId}`)
        await execAsync(`docker exec env chmod 700 /home/${sessionId}`)

        await hubInstance.post(`/users/${sessionId}`)

        // Create token
        const { token: userToken } = await hubInstance.post(`/users/${sessionId}/tokens`).then(r => r.data)
        console.log(`got token ${userToken} for user ${sessionId}`)

        /* Note: does not automatically create a jupyter server */
        // await hubInstance.post(`/users/${sessionId}/server`, undefined) // start new server

        // const terminalResponse = await serverInstance.post(`/${sessionId}/api/terminals`, undefined, { headers: { "Authorization": `token ${userToken}` } }).then(r => r.data)

        // Create Dyte meeting
        const createMeetingResponse = await dyteInstance.post("/meetings").then(r => r.data)
        const meetingId = createMeetingResponse.data.id

        await makeQuery(conn, "INSERT INTO Rooms (id, code, dyte_meeting_id, jupyter_server_token) VALUES (?, '', ?, ?)", [sessionId, meetingId, userToken])

        // Insert participant into dyte meeting
        const insertionResponse = await dyteInstance.post(`/meetings/${meetingId}/participants`, {
            preset_name: "group_call_participant",
            custom_participant_id: userEmail,
            name: username
        }).then(r => r.data)

        await makeQuery(conn, "INSERT INTO Participants (room_id, user_email, dyte_token, dyte_participant_id) VALUES (?, ?, ?, ?)", [sessionId, userEmail, insertionResponse.data.token, insertionResponse.data.id])

        // Set timeout to delete room upon creation of the room
        roomTimeouts.set(sessionId, setTimeout(async () => {
            const [deleteRoom] = await makeQuery(conn, "DELETE FROM Rooms WHERE id = ?", [sessionId])
            await serverInstance.delete(`/users/${sessionId}/server`, undefined)
            Map.prototype.delete(sessionId)
        }, 1000 * 30)) // 1 hour

        res.json({
            room_id: sessionId,
            existing: false,
            already_in_room: false
        })
    } catch (error) {
        console.warn(error)
        res.send(400)
    } finally {
        conn.release()
    }
})

roomRouter.post("/:room_id/create-server", async (req, res) => {
    const sessionId: string = req.params.room_id
    if (!sessionId) {
        res.status(400).send("Session ID not provided")
    }
    let conn: PoolConnection | undefined

    try {
        // Create server
        const createServerResponse = await hubInstance.post(`/users/${sessionId}/server`, undefined)
        .then(response => {
            return response.status
        })
        .catch(err => {
            return err.response.status
        })

        if (createServerResponse === 400) {
            const terminalInfo = await serverInstance.get(`/${req.params.room_id}/api/terminals`, { headers: authHeader }).then(r => r.data)

            if (terminalInfo.length > 0) {
                await serverInstance.delete(`/${req.params.room_id}/api/terminals/${terminalInfo[0].name}`, { headers: authHeader })
            }

            const newTerminal = await serverInstance.post(`/${req.params.room_id}/api/terminals`, undefined, { headers: authHeader }).then(r => r.data)
            return res.json({ "terminal_id": newTerminal.name })
            // return res.status(400).send("Server already started")
        }

        conn = await getConnection()
        const [roomInfo] = await makeQuery(conn, "SELECT jupyter_server_token FROM Rooms WHERE id = ?", [req.params.room_id])

        if (roomInfo.length === 0) {
            return res.status(404).send("Invalid room ID.")
        }

        const userToken = roomInfo[0].jupyter_server_token

        const terminalResponse = await serverInstance.post(`/${sessionId}/api/terminals`, undefined, { headers: { "Authorization": `token ${userToken}` } }).then(r => r.data)

        res.json({ "token": userToken, "terminal_id": terminalResponse.name })
    } catch (error) {
        console.warn(error)
        res.send(400)
    }
})

// Internal use only
roomRouter.post("/:room_id/terminate-server", async (req, res) => {
    const sessionId: string = req.params.room_id
    if (!sessionId) {
        res.status(400).send("Session ID not provided")
    }
    try {
        await execAsync(`docker exec env deluser ${sessionId}`).catch(err => err)
        await execAsync(`docker exec env rm -rf /home/${sessionId}`)
        await hubInstance.delete(`/users/${sessionId}/server`).catch(err => {})
        await hubInstance.delete(`/users/${sessionId}`).catch(err => {})

        const conn = await getConnection()
        await makeQuery(conn, "DELETE FROM Rooms WHERE id = ?", [req.params.room_id])

        conn.release()

        res.send("Server terminated successfully")
    } catch (error) {
        console.log("failed to terminate server")
        return res.status(400).send("Server not opened")
    }
})

roomRouter.post("/:room_id/restart-server", async (req, res) => {
    const userData = await hubInstance.get(`/users/${req.params.room_id}`)
        .then(r => r.data)
        .catch(err => {
            return undefined
        })
    
    if (userData) {
        const terminalInfo = await serverInstance.get(`/${req.params.room_id}/api/terminals`, { headers: authHeader }).then(r => r.data)

        if (terminalInfo.length > 0) {
            await serverInstance.delete(`/${req.params.room_id}/api/terminals/${terminalInfo[0].name}`, { headers: authHeader })
        }

        const newTerminal = await serverInstance.post(`/${req.params.room_id}/api/terminals`, undefined, { headers: authHeader }).then(r => r.data)

        res.json({
            user: userData,
            terminal: newTerminal
        })
    } else {
        res.json(null)
    }
})

roomRouter.post("/:room_id/code", async (req, res) => {
    if (typeof req.body?.file !== "string" || typeof req.body?.author_map !== "string") {
        return res.status(400).send("Must contain `file` in request body")
    }

    const conn = await getConnection()

    try {
        const [room] = await makeQuery(conn, "SELECT id FROM Rooms WHERE id = ?", [req.params.room_id])
        if (room.length === 0) {
            return res.status(404).send("Did not find the room id")
        }
        // Update on server
        await execAsync(`docker exec -u ${req.params.room_id} env bash -c 'echo -e ${JSON.stringify(req.body.file)} > /home/${req.params.room_id}/main.py'`)

        // Update on DB
        await makeQuery(conn, "UPDATE Rooms SET code = ?, author_map = ? WHERE id = ?", [req.body.file, req.body.author_map, req.params.room_id])
        await conn.commit()
        
        res.send("File saved")
    } catch (error) {
        conn.rollback()
        console.log(error)
        return res.status(400).send("Server not opened")
    } finally {
        conn.release()
    }
})

/*
roomRouter.post("/:room_id/run", async (req, res) => {
    const conn = await getConnection()
    try {
        const [room] = await makeQuery(conn, "SELECT code, question_id FROM Rooms WHERE id = ?", [req.params.room_id])
        if (room.length === 0) {
            return res.status(404).send("Did not find the room id")
        }

        const [testcases] = await makeQuery(conn, "SELECT title, stdin, stdout FROM TestCases WHERE question_id = ?", [room[0].question_id])

        if (testcases.length === 0) {
            return res.status(404).send("Question id not set or did not find test cases for question")
        }

        const cases = testcases.map(async (testcase: any) => {
            const response = await pistonInstance.post("/execute", {
                language: "python",
                version: "3.12.0",
                stdin: testcase.stdin,
                files: [
                    { name: "main.py", content: room[0].code }
                ]
            })
            return {title: testcase.title, stdin: testcase.stdin, expected: testcase.stdout, observed: response.data.run.stdout, is_correct: response.data.run.stdout === testcase.stdout};
        })

        const results = await Promise.all(cases)
        
        res.status(200).json({ cases: results })
    } catch {
        res.sendStatus(500);
    } finally {
        conn.release()
    }
   
})
*/

roomRouter.post("/:room_id/test_results", async (req, res) => {

    /* Check that test results exist in body */
    if (!req.body?.test_results || !(req.body.test_results instanceof Array)) {
        return res.status(400).send("Must provide `test_results` as array in body.")
    }

    const conn = await getConnection()
    try {
        await makeQuery(conn, "UPDATE Rooms SET test_results = ? WHERE id = ?", [JSON.stringify(req.body.test_results), req.params.room_id])
        res.send()
    } catch (error) {
        console.log(error)
        res.status(500).send("Internal server error")
    } finally {
        conn.release()
    }
})

// Update question id of room
roomRouter.patch("/:room_id", async (req, res) => {

    if (typeof req.body?.question_id !== "string") {
        return res.status(400).send("Must provide `question_id` as string in body.")
    }

    const conn = await getConnection()
    try {
        const testCases = await makeQuery(conn, "SELECT * FROM TestCases WHERE question_id = ?", [req.body.question_id])
        if (testCases.length === 0) {
            return res.status(404).send("Question id not found.")
        }

        await makeQuery(conn, "UPDATE Rooms SET question_id = ? WHERE id = ?", [req.body.question_id, req.params.room_id])

        res.send(testCases[0])
    } catch (error) {
        console.log(error)
        res.status(500).send("Internal server error")
    } finally {
        conn.release()
    }
})

roomRouter.post("/:room_id/heartbeat", async (req,res) =>{
    const conn = await getConnection();
    const sessionId = req.params.room_id
    try {
        const [room] = await makeQuery(conn,`SELECT * FROM Rooms WHERE id = ?`,[sessionId])
        if ( room.length === 0){
            return res.status(404).send("Did not find the room with the given id")
        }

        clearTimeout(roomTimeouts.get(sessionId))
        roomTimeouts.set(sessionId, setTimeout(async () => {
            const [deleteRoom] = await makeQuery(conn, "DELETE FROM Rooms WHERE id = ?", [sessionId])
            await serverInstance.delete(`/users/${sessionId}/server`, undefined)
            Map.prototype.delete(sessionId)
        }, 1000 * 60 * 60)) // 1 hour

        console.log("Heartbeat received for room", sessionId)
    } catch{
        res.status(500).send("Internal server error")
    }
})