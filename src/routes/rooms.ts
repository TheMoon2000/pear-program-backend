import { Router } from "express";
import { exec } from "child_process";
import fs from "fs";
import { hubInstance, serverInstance } from "../../constants";
import { getConnection, makeQuery } from "../utils/database";
import axios from "axios";

const pistonInstance = axios.create({ baseURL: "http://172.174.247.133/piston/api/v2" })
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
            "SELECT id, code, is_full, question_id FROM Rooms WHERE id = ?", 
            [req.params.room_id])
        if (room.length === 0) {
            return res.status(404).send("Did not find the room with the given id")
        }

        // Get test cases
        const [testcases] = await makeQuery(conn, 
            "SELECT title, stdin, stdout FROM TestCases WHERE question_id = ?", 
            [room[0].question_id])

        // Create temporary token
        const { token: userToken, id } = await hubInstance.post(`/users/${req.params.room_id}/tokens`, { expires_in: 60 }).then(r => r.data)
        // Get terminal information
        const terminalInfo = await serverInstance.get(`/${req.params.room_id}/api/terminals`, { headers: { Authorization: `token ${userToken}` } }).then(r => r.data)

        await hubInstance.delete(`/users/${req.params.room_id}/tokens/${id}`)

        const [meeting] = await makeQuery(conn, 
            "SELECT dyte_participant_id AS participant_id, dyte_token AS meeting_id FROM Participants WHERE room_id = ? AND user_email = ?", 
            [req.params.room_id, email])

        const [allParticipants] = await makeQuery(conn,
            `SELECT p.dyte_participant_id AS participant_id, u.name FROM Participants p LEFT JOIN Users u ON p.user_email = u.email
            WHERE room_id = ?`,
            [req.params.room_id])
        
        if (meeting.length === 0) {
            meeting.push({ participant_id: null, meeting_id: null, user_token: null})
        } else {
            meeting[0].user_token = userToken;
        }
        meeting[0].all_participants = allParticipants;
        
        res.status(200).json({room, test_cases: testcases.length !== 0 ? testcases : null
            , server: terminalInfo.length !== 0 ? terminalInfo[0].name : null, meeting: meeting[0]})
        } catch {
            res.sendStatus(500);
        } finally {
            conn.release();
        }
})

roomRouter.post("/", async (req, res) => {
    const conn = await getConnection()
    const email = req.body.email as string | undefined

    if (!email) {
        return res.status(400).send("Email not provided")
    }
    try {
        const { question_id, user_id } = req.body
        const [room] = await makeQuery(conn, "INSERT INTO Rooms", [question_id, user_id])
        res.json({ room_id: room.insertId })
    } catch {
        res.sendStatus(500)
    } finally {
        conn.release()
    }
})

roomRouter.post("/:room_id/create-server", async (req, res) => {
    const sessionId: string = req.params.room_id
    if (!sessionId) {
        res.status(400).send("Session ID not provided")
    }
    try {
        await execAsync(`docker exec env useradd ${sessionId}`)
        await execAsync(`docker exec env mkdir /home/${sessionId}`)
        await execAsync(`docker exec env chown ${sessionId}:${sessionId} /home/${sessionId}`)


        // Create user
        await hubInstance.post(`/users/${sessionId}`)

        // Create token
        const { token: userToken } = await hubInstance.post(`/users/${sessionId}/tokens`, { expires_in: 86400 }).then(r => r.data)
        console.log(`got token ${userToken} for user ${sessionId}`)
        await hubInstance.post(`/users/${sessionId}/server`, undefined)

        const terminalResponse = await serverInstance.post(`/${sessionId}/api/terminals`, undefined, { headers: { "Authorization": `token ${userToken}` } }).then(r => r.data)

        res.json({ "token": userToken, "terminal_id": terminalResponse.name })
    } catch (error) {
        console.warn(error)
        res.send(400)
    }
})

roomRouter.post("/:room_id/terminate-server", async (req, res) => {
    const sessionId: string = req.params.room_id
    if (!sessionId) {
        res.status(400).send("Session ID not provided")
    }
    try {
        await execAsync(`docker exec env deluser ${sessionId}`)
        await execAsync(`docker exec env rm -rf /home/${sessionId}`)
        await hubInstance.delete(`/users/${sessionId}`)
        res.send("Server terminated successfully")
    } catch (error) {
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
        // Create temporary token
        const { token: userToken, id } = await hubInstance.post(`/users/${req.params.room_id}/tokens`, { expires_in: 60 }).then(r => r.data)

        const terminalInfo = await serverInstance.get(`/${req.params.room_id}/api/terminals`, { headers: { Authorization: `token ${userToken}` } }).then(r => r.data)

        if (terminalInfo.length > 0) {
            await serverInstance.delete(`/${req.params.room_id}/api/terminals/${terminalInfo[0].name}`, { headers: { Authorization: `token ${userToken}` } })
        }

        const newTerminal = await serverInstance.post(`/${req.params.room_id}/api/terminals`, undefined, { headers: { Authorization: `token ${userToken}` } }).then(r => r.data)

        await hubInstance.delete(`/users/${req.params.room_id}/tokens/${id}`)

        res.json({
            user: userData,
            terminal: newTerminal
        })
    } else {
        res.json(null)
    }
})

roomRouter.post("/:room_id/code", async (req, res) => {
    const conn = await getConnection()
    if (!req.body?.file) {
        return res.status(400).send("Must contain `file` in request body")
    }

    const serializedFile = JSON.stringify(req.body.file)

    try {
        const [room] = await makeQuery(conn, "SELECT code FROM Rooms WHERE id = ?", [req.params.room_id])
        if (room.length === 0) {
            return res.status(404).send("Did not find the room id")
        }

        // Update on server
        await execAsync(`docker exec env sh -c 'printf "%s" "$1" > /home/${req.params.room_id}/main.py' sh ${serializedFile}`)

        // Update on DB
        await makeQuery(conn, "UPDATE Rooms SET code = ? WHERE id = ?", [serializedFile, req.params.room_id])
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
