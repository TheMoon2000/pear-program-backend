import express from "express";
import fs from "fs";
import {v4} from "uuid"
import cors from 'cors';
import axios from "axios";
import 'dotenv/config';
import "./chat";
import { roomRouter } from "./routes/rooms";
import { getConnection, makeQuery } from "./utils/database";

const app = express()
const port = 8011

const corsOptions = {
    origin: "*"
};
app.use(cors(corsOptions));
app.use(express.json());
app.use("/rooms", roomRouter);

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

app.listen(port, () => {
    console.log(`Pear Program backend listening on port ${port}`)
})