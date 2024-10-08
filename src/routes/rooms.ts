import { Router } from "express";
import { exec } from "child_process";
import fs from "fs";
import { Snapshot, authHeader, hubInstance, serverInstance, zoomInstance } from "../constants";
import axios from "axios";
import { v4 } from "uuid";
import { makeQuery, getConnection } from "../utils/database";
import { PoolConnection } from "mysql2/promise";
import { sendNotificationToRoom, sendEventOfType, socketMap, roomMembershipMutex } from "../chat";
import { WebSocket } from "ws";
import { Mutex } from "async-mutex";
import fastq, { asyncWorker } from "fastq"

const pistonInstance = axios.create({ baseURL: "http://127.0.0.1:2000/api/v2" })
const dyteInstance = axios.create({ baseURL: "https://api.dyte.io/v2", headers: { Authorization: `Basic ${process.env.DYTE_AUTH}`} })
const roomTimeouts = new Map<string, NodeJS.Timeout>();

export const roomRouter = Router()

export async function getZoomAccessToken() {
    return (await axios.post("https://zoom.us/oauth/token", `grant_type=refresh_token&refresh_token=${encodeURIComponent(process.env.ZOOM_REFRESH_TOKEN as string)}`,
    { headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: process.env.ZOOM_AUTH
    } })).data.access_token as string
}

export async function execAsync(command: string) {
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

roomRouter.get("/heartbeat", async (req, res) => {
    res.send(Array.from(roomTimeouts.keys()))
})

// Get all question testcases
roomRouter.get("/testcases", async (req, res) => {
    const conn = await getConnection()

    try {
        const [testcases] = await makeQuery(conn, "SELECT question_id, title FROM TestCases")
        res.json(testcases)
    } catch (error) {
        console.error(error)
        res.sendStatus(500)
    } finally {
        conn.release()
    }
});

// Get all rooms the user has participated in
roomRouter.post("/participations", async (req, res) => {
    if (typeof req.body?.email !== "string") {
        return res.status(400).send("Must provide email in body.")
    }

    const conn = await getConnection()

    try{
        const [rooms] = await makeQuery(conn, 
            `SELECT r.id, r.creation_date, r.last_updated
            FROM Rooms r LEFT JOIN Participants p ON r.id = p.room_id
            WHERE p.user_email = ?`, 
            [req.body.email])

        res.json(rooms)
    } catch (error) {
        console.log(error)
        return res.status(400).send("Server not opened")
    } finally {
        conn.release()
    }
})

roomRouter.get("/recent-activity", async (req, res) => {
    const email = req.query.email
    if (typeof email !== "string") {
        return res.
        status(400).send("Must provide `email` as string in params.")
    }

    const conn = await getConnection();
    try {
        const [history] = await makeQuery(conn, `
            SELECT p1.room_id, p1.last_visited, Users.name as partner FROM Participants p1
            LEFT JOIN Participants p2 ON p1.room_id = p2.room_id AND p1.user_email != p2.user_email
            LEFT JOIN Users ON Users.email = p2.user_email
            WHERE p1.user_email = ? AND DATE_ADD(p1.last_visited, INTERVAL 1 DAY) > NOW()`, [email])

        res.json({
            history: history
        })
    } catch (err) {
        console.warn(err)
        res.status(500).send("Internal server error")
    } finally {
        conn.release()
    }
})

roomRouter.get("/:room_id", async(req, res) => {
    const email = req.query.email as string | undefined;
    const conn = await getConnection();

    try {
        // Get room information
        const [room] = await makeQuery(conn, 
            "SELECT Rooms.*, test_cases, use_graphics FROM Rooms LEFT JOIN TestCases ON TestCases.question_id = Rooms.question_id WHERE id = ?", 
            [req.params.room_id])
        if (room.length === 0) {
            return res.status(404).send("Did not find the room with the given id")
        }

        room[0].use_graphics = room[0].use_graphics > 0

        const rustpadHistory = await axios.get(`https://rustpad.io/api/text/${req.params.room_id}`)
        const authorHistory = await axios.get(`https://rustpad.io/api/text/${req.params.room_id}-authors`)
        if (rustpadHistory.data) {
            room[0].rustpad_code = (rustpadHistory.data as string).replace("\r\n", "\n")
        } else {
            // Insert starter code into rustpad
            console.log(await new Promise<any>((r, _) => {
                const roomWs = new WebSocket(`wss://rustpad.io/api/socket/${req.params.room_id}`)
                roomWs.once("open", () => {
                    roomWs.send(JSON.stringify({
                        Edit: { revision: 0, operation: [room[0].code] }
                    }), r)
                })
            }))
        }

        if (authorHistory.data) {
            room[0].rustpad_author_map = authorHistory.data
        } else {
            await new Promise<any>((r, _) => {
                const authorWs = new WebSocket(`wss://rustpad.io/api/socket/${req.params.room_id}-authors`)
                authorWs.once("open", () => {
                    authorWs.send(JSON.stringify({
                        Edit: { revision: 0, operation: [room[0].author_map] }
                    }), r)
                })
            })
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
            "SELECT zoom_registrant_id, zoom_url, role FROM Participants WHERE room_id = ? AND user_email = ?", 
            [req.params.room_id, email])
        if (selfParticipant.length === 0) {
            selfParticipant.push({ zoom_registrant_id: null, zoom_url: null})
        }

        const [allParticipants] = await makeQuery(conn,
            `SELECT p.zoom_registrant_id, u.name, role FROM Participants p LEFT JOIN Users u ON p.user_email = u.email
            WHERE room_id = ? ORDER BY joined_date`,
            [req.params.room_id])
        
        allParticipants.forEach((item: any, i: number) => {
            item.index = i
            if (selfParticipant[0]?.zoom_registrant_id === item.zoom_registrant_id) {
                selfParticipant[0].index = i
            }
        })   
        
        await makeQuery(conn, "UPDATE Participants SET last_visited = NOW() WHERE room_id = ? AND user_email = ?", [req.params.room_id, email])
        
        res.status(200).json({
            room: room[0],
            server: {
                terminal_id: terminalId
            },
            author_id: selfParticipant[0].index,
            meeting: {
                meeting_id: room[0].zoom_meeting_id,
                all_participants: allParticipants,
                zoom_url: selfParticipant[0]?.zoom_url,
                role: selfParticipant[0]?.role
            }
        })
        } catch (error) {
            console.error(error)
            res.sendStatus(500);
        } finally {
            conn.release();
        }
})

roomRouter.post("/:room_id/create-server", async (req, res) => {
    const sessionId: string = req.params.room_id
    if (!sessionId) {
        res.status(400).send("Session ID not provided")
    }

    if (typeof req.body?.email !== "string") {
        return res.status(400).send("Must provide `email` in body.")
    }

    const showWelcomeMessage = Boolean(req.body?.show_welcome_message)

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
            
            await sendEventOfType(req.params.room_id, "terminal_started", req.body.email, { terminal_id: newTerminal.name, show_welcome_message: showWelcomeMessage })
            return res.json({ "terminal_id": newTerminal.name })
            // return res.status(400).send("Server already started")
        }

        conn = await getConnection()
        const [roomInfo] = await makeQuery(conn, "SELECT jupyter_server_token FROM Rooms WHERE id = ?", [sessionId])

        if (roomInfo.length === 0) {
            return res.status(404).send("Invalid room ID.")
        }

        // Set timeout to close server upon initialization of the room server
        roomTimeouts.set(sessionId, setTimeout(async () => {
            await hubInstance.delete(`/users/${sessionId}/server`, undefined).catch(err => {})
            roomTimeouts.delete(sessionId)
            console.log("Deleted room", sessionId)
        }, 1000 * 60 * 60)) // 1 hour

        const userToken = roomInfo[0].jupyter_server_token

        const terminalResponse = await serverInstance.post(`/${sessionId}/api/terminals`, undefined, { headers: { "Authorization": `token ${userToken}` } }).then(r => r.data)

        await sendEventOfType(req.params.room_id, "terminal_started", req.body.email, { terminal_id: terminalResponse.name, show_welcome_message: showWelcomeMessage })

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
        // const [roomInfo] = await makeQuery(conn, "SELECT dyte_meeting_id FROM Rooms WHERE id = ?", [req.params.room_id])
        // if (roomInfo.length > 0) {
        //     await dyteInstance.patch(`/meetings/${roomInfo[0].dyte_meeting_id}`, { status: "INACTIVE" })
        //     await makeQuery(conn, "DELETE FROM Rooms WHERE id = ?", [req.params.room_id])
        // }

        await makeQuery(conn, "DELETE FROM Rooms WHERE id = ?", [req.params.room_id])

        conn.release()

        res.send("Server terminated successfully")
    } catch (error) {
        console.log("failed to terminate server")
        return res.status(400).send("Server not opened")
    }
})

roomRouter.post("/:room_id/restart-server", async (req, res) => {

    if (typeof req.body?.email !== "string") {
        return res.status(400).send("Must provide `email` in body.")
    }

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

        await sendEventOfType(req.params.room_id, "terminal_started", req.body.email, { terminal_id: newTerminal.name, show_welcome_message: true })

        res.json({
            user: userData,
            terminal: newTerminal
        })
    } else {
        res.json(null)
    }
})

function escapeCmd(cmd: string) {
    return '"'+cmd.replace(/(["'$`\\])/g,'\\$1')+'"';
};

roomRouter.post("/:room_id/code", async (req, res) => {
    if (typeof req.body?.file !== "string" || typeof req.body?.author_map !== "string") {
        return res.status(400).send("Must contain `file` and `author_map` in request body")
    }

    let question_id;
    const conn = await getConnection()

    try {
        // Update on DB
        const [room] = await makeQuery(conn, "UPDATE Rooms SET code = ?, author_map = ?, last_updated = Now(3) WHERE id = ?", [req.body.file, req.body.author_map, req.params.room_id])
        
        if (room.affectedRows === 0) {
            return res.status(404).send("Room not found")
        }

        // Get question_id
        if (typeof req.body?.question_id === "string") {
            question_id = req.body.question_id;
        } else{
            const [roomInfo] = await makeQuery(conn, "SELECT question_id FROM Rooms WHERE id = ?", [req.params.room_id])
            question_id = roomInfo[0].question_id
        }
        await makeQuery(conn, "INSERT IGNORE INTO Snapshots (room_id, code, author_map, question_id) VALUES (?, ?, ?, ?)" , 
        [req.params.room_id, req.body.file, req.body.author_map, question_id])

        // Update code on server
        // await serverInstance.put(`/${req.params.room_id}/api/contents/main.py`, {
        //     type: "file",
        //     format: "text",
        //     content: req.body.file
        // }, { headers: authHeader })
        const originalCode = JSON.stringify(req.body.file).replace(/\$/g, '\\$')
        const command = `docker exec -u ${req.params.room_id} env bash -c "echo -e '${originalCode.slice(1, originalCode.length - 1).replace(/'/g, "'\\''")}' > /home/${req.params.room_id}/main.py"`
        await execAsync(command)

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

    if (typeof req.body?.email !== "string") {
        return res.status(400).send("Must provide `email` as string in body.")
    }

    const conn = await getConnection()
    try {
        const [currentQuestion] = await makeQuery(conn, "SELECT Rooms.question_id, TestCases.title FROM Rooms INNER JOIN TestCases ON Rooms.question_id = TestCases.question_id WHERE id = ?", [req.params.room_id])
        
        if (currentQuestion.length === 0) {
            return res.status(404).send("Room not found")
        }

        let isCorrect = true
        req.body.test_results.forEach((r: any) => {
            if (!r.isCorrect) {
                isCorrect = false
            }
        })

        if (isCorrect && req.body.test_results.length !== 0) {
            socketMap.get(req.params.room_id)?.ai.onQuestionPassed(currentQuestion[0].question_id, currentQuestion[0].title, req.body.test_results)
        }

        await makeQuery(conn, "UPDATE Rooms SET test_results = ? WHERE id = ?", [JSON.stringify(req.body.test_results), req.params.room_id])
        await sendEventOfType(req.params.room_id, "autograder_update", req.body.email, { results: req.body.test_results })
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

    if (typeof req.body?.question_id !== "string" || typeof req.body?.name !== "string" || typeof req.body?.email !== "string") {
        return res.status(400).send("Must provide `question_id`, `name`, and `email` as string in body.")
    }

    const conn = await getConnection()
    try {
        const [testCases] = await makeQuery(conn, "SELECT * FROM TestCases WHERE question_id = ?", [req.body.question_id])
        if (testCases.length === 0) {
            return res.status(404).send("Question id not found.")
        }

        const author_map = testCases[0].starter_code.replace(/[^\n]/g, "?")
        
        const [room] = await makeQuery(conn, "UPDATE Rooms SET code = ?, author_map = ?, question_id = ? WHERE id = ?", 
                        [testCases[0].starter_code, author_map, req.body.question_id, req.params.room_id])
        if (room.affectedRows === 0) {
            return res.status(404).send("Room id not found.")
        }

        socketMap.get(req.params.room_id)?.ai.send([
            {
                type: "text",
                value: testCases[0].description
            }
        ])

        
        const currentText = (await axios.get(`https://rustpad.io/api/text/${req.params.room_id}`)).data

        await makeQuery(conn, "INSERT INTO Snapshots (room_id, code, author_map, question_id) VALUES (?, ?, ?, ?)",
                    [req.params.room_id, testCases[0].starter_code, author_map, req.body.question_id])

        await new Promise<any>((r, _) => {
            const roomWs = new WebSocket(`wss://rustpad.io/api/socket/${req.params.room_id}`)
            roomWs.on("message", (data: Buffer, isBinary) => {
                const rawMessage = JSON.parse(data.toString())
                if (rawMessage.History && rawMessage.History.start === 0) {
                    const nextOperation = rawMessage.History.operations.length
                    roomWs.send(JSON.stringify({
                        "CursorData": { "cursors": [currentText.length], "selections": [[0, currentText.length]] }
                    }), () => {
                        roomWs.send(JSON.stringify({
                            "Edit": { revision: nextOperation, "operation": [-currentText.length] }
                        }), () => {
                            console.log(JSON.stringify({
                                Edit: { revision: nextOperation + 1, operation: [testCases[0].starter_code] }
                            }))
                            roomWs.send(JSON.stringify({
                                Edit: { revision: nextOperation + 1, operation: [testCases[0].starter_code] }
                            }), r)
                        })
                    })
                }
            })

            roomWs.on("error", (error) => {
                console.log(error)
            })
        })

        const initialAuthorMap = testCases[0].starter_code.replace(/[^\n]/g, "?")
        const currentAuthorCode = (await axios.get(`https://rustpad.io/api/text/${req.params.room_id}-authors`)).data

        await new Promise<any>((r, _) => {
            const authorWs = new WebSocket(`wss://rustpad.io/api/socket/${req.params.room_id}-authors`)
            authorWs.on("message", (data: Buffer, isBinary) => {
                const rawMessage = JSON.parse(data.toString())
                if (rawMessage.History && rawMessage.History.start === 0) {
                    const nextOperation = rawMessage.History.operations.length
                    authorWs.send(JSON.stringify({
                        "CursorData": { "cursors": [currentAuthorCode.length], "selections": [[0, currentAuthorCode.length]] }
                    }), (err) => {
                        if (err) console.log('cursor failed', err)
                        authorWs.send(JSON.stringify({
                            "Edit": { revision: nextOperation, "operation": [-currentAuthorCode.length] }
                        }), (err) => {
                            if (err) {
                                console.log('delete failed', err)
                            }
                            authorWs.send(JSON.stringify({
                                Edit: { revision: nextOperation + 1, operation: [initialAuthorMap] }
                            }), r)
                        })
                    })
                }
            })
        })

        // write into the docker container
        const originalCode = JSON.stringify(testCases[0].starter_code).replace(/\$/g, '\\$')
        const command = `docker exec -u ${req.params.room_id} env bash -c "echo -e '${originalCode.slice(1, originalCode.length - 1).replace(/'/g, "'\\''")}' > /home/${req.params.room_id}/main.py"`
        await execAsync(command)

        await sendEventOfType(req.params.room_id, "question_update", req.body.email, { email: req.body.email, question: testCases[0] })
        await sendNotificationToRoom(req.params.room_id, `${req.body.name} has changed the problem to ${testCases[0].title}`)
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
        const timeout = roomTimeouts.get(sessionId)
        if (timeout) {
            clearTimeout(timeout)
            roomTimeouts.set(sessionId, setTimeout(async () => {
                await hubInstance.delete(`/users/${sessionId}/server`, undefined).catch(err => {})
                roomTimeouts.delete(sessionId)
                console.log("Deallocated server for room", sessionId)
            }, 1000 * 60 * 60)) // 1 hour
        } else {
            const [roomInfo] = await makeQuery(conn, "SELECT id FROM Rooms WHERE id = ?", [sessionId])
            if (roomInfo.length === 0) {
                return res.status(404).send("Room id not found.")
            }

            roomTimeouts.set(sessionId, setTimeout(async () => {
                await hubInstance.delete(`/users/${sessionId}/server`, undefined).catch(err => {})
                roomTimeouts.delete(sessionId)
                console.log("Deallocated server for room", sessionId)
            }, 1000 * 60 * 60))
        }

        res.status(200).send("Heartbeat received")
    } catch {
        res.status(500).send("Internal server error")
    } finally {
        conn.release()
    }
})

roomRouter.post("/:room_id/switch-roles", async (req, res) => {
    const currentRole = req.body?.role
    const email = req.body?.email
    if (typeof currentRole !== "number") {
        return res.status(400).send("Must provide `role` as number in body.")
    }
    if (typeof email !== "string") {
        return res.status(400).send("Must provide `email` as string in body.")
    }
    
    if (currentRole !== 1 && currentRole !== 2) {
        return res.status(400).send("Cannot switch role before receiving a initial role assignment.")
    }

    const otherRole = 3 - currentRole

    const conn = await getConnection();
    try {
        // Check room exists
        const [roomInfo] = await makeQuery(conn, "SELECT id FROM Rooms WHERE id = ?", [req.params.room_id])
        if (roomInfo.length === 0) {
            console.log(req.params.room_id, roomInfo)
            return res.status(404).send()
        }

        // Update self role
        await makeQuery(conn, "UPDATE Participants SET role = ? WHERE room_id = ? AND user_email = ?", [otherRole, req.params.room_id, email])

        // Update partner role
        await makeQuery(conn, "UPDATE Participants SET role = ? WHERE room_id = ? AND user_email != ?", [currentRole, req.params.room_id, email])

        const [newRoles] = await makeQuery(conn, "SELECT user_email, role FROM Participants WHERE room_id = ?", [req.params.room_id])

        res.json({
            role: otherRole
        })
        await sendEventOfType(req.params.room_id, "update_role", email, { roles: Object.fromEntries(newRoles.map((p: any) => [p.user_email, p.role])) })
    } catch {
        res.status(500).send("Internal server error")
    } finally {
        conn.release()
    }
})

// Internal testing only
roomRouter.post("/:room_id/notification", async (req, res) => {
    const message = req.body?.message
    if (typeof message !== "string") {
        return res.status(400).send("Notification must provide `message` as string in body")
    }

    const success = await sendNotificationToRoom(req.params.room_id, message)
    if (success) {
        return res.status(200).send("Successfully sent notification")
    } else {
        res.status(400).send("Cannot send message to inactive room.")
    }
})

roomRouter.post("/:room_id/grade", async (req, res) => {
    let bruno = socketMap.get(req.params.room_id)?.ai
    if (bruno) {
        await bruno.composeAiGraderMessages().catch(err => {
            console.warn(err)
            res.status(400).send()
        })
        res.send()
    } else {
        res.status(400).send()
    }
})

// Internal use
export async function getCodeHistoryOfRoom(roomId: string): Promise<Snapshot[]> {
    const conn = await getConnection()
    const [snapshots] = await makeQuery(conn, `SELECT timestamp, code, author_map, question_id FROM Snapshots WHERE room_id = ? ORDER BY timestamp`, [roomId])
    conn.release()
    
    return snapshots
}