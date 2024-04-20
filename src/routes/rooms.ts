import { Router } from "express";
import { exec } from "child_process";
import fs from "fs";
import { hubInstance, serverInstance } from "../../constants";
import axios from "axios";

const pistonInstance = axios.create({ baseURL: "http://127.0.0.1:2000/api/v2" })
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
    const userData = await hubInstance.get(`/users/${req.params.room_id}`)
        .then(r => r.data)
        .catch(err => {
            return undefined
        })
        
    if (userData) {
        // Create temporary token
        const { token: userToken, id } = await hubInstance.post(`/users/${req.params.room_id}/tokens`, { expires_in: 60 }).then(r => r.data)

        const terminalInfo = await serverInstance.get(`/${req.params.room_id}/api/terminals`, { headers: { Authorization: `token ${userToken}` } }).then(r => r.data)

        await hubInstance.delete(`/users/${req.params.room_id}/tokens/${id}`)

        res.json({
            user: userData,
            terminal: terminalInfo[0]
        })
    } else {
        res.json({ user: null })
    }
    
})

roomRouter.post("/", async (req, res) => {

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
    if (!req.body?.file) {
        return res.status(400).send("Must contain `file` in request body")
    }

    const serializedFile = JSON.stringify(req.body.file)

    try {
        await execAsync(`docker exec env sh -c 'printf "%s" "$1" > /home/${req.params.room_id}/main.py' sh ${serializedFile}`)
        res.send("File saved")
    } catch (error) {
        console.log(error)
        return res.status(400).send("Server not opened")
    }
})

roomRouter.post("/:room_id/run", async (req, res) => {
    const response = await pistonInstance.post("/execute", {
        language: "python",
        version: "3.12.0",
        stdin: "10",
        files: [
            { name: "main.py", content: "x = int(input())\nwhile x < 100:\n    x *= 2\n    print(x)" }
        ]
    })
    res.json(response.data)
})

roomRouter.get("/:room_id", async (req, res) => {
    
})