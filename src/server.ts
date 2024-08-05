import express from "express";
import fs from "fs";
import {v4} from "uuid"
import cors from 'cors';
import axios from "axios";
import 'dotenv/config';
import "./chat";
import "./queue_system";
import { roomRouter, getZoomAccessToken } from "./routes/rooms";
import { getConnection, makeQuery } from "./utils/database";
import webhookRouter from "./routes/webhooks";
import queueRouter from "./routes/queue";

const app = express()
const port = 8010

const corsOptions = {
    origin: "*"
};
app.use(cors(corsOptions));
app.use(express.json());
app.use("/rooms", roomRouter);
app.use("/webhooks", webhookRouter);
app.use("/queue", queueRouter);

app.get("/", async (req, res) => {
    res.send("success")
})

app.get("/questions", async (req, res) => {
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

app.get("/questions/:question_id", async (req, res) => {
    const conn = await getConnection()

    try {
        const [testcases] = await makeQuery(conn, "SELECT * FROM TestCases WHERE question_id = ?", [req.params.question_id])
        res.json(testcases[0])
    } catch (error) {
        console.error(error)
        res.sendStatus(500)
    } finally {
        conn.release()
    }
});

app.get("/zoom_access_token", async (req, res) => {
    if (req.query.secret === "pearprogram-recall-secret-string") {
        const accessToken = await getZoomAccessToken()
        res.send(accessToken)
    } else {
        res.send()
    }
})

app.listen(port, async () => {
    let conn = await getConnection()
    await makeQuery(conn, "UPDATE Participants SET is_online = 0")
    conn.release()
    
    console.log(`Pear Program backend listening on port ${port}`)
})