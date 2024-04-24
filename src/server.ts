import express from "express";
import fs from "fs";
import {v4} from "uuid"
import cors from 'cors';
import axios from "axios";
import 'dotenv/config';
import { roomRouter } from "./routes/rooms";

const app = express()
const port = 8010

const corsOptions = {
    origin: "*"
};
app.use(cors(corsOptions));
app.use(express.json());
app.use("/rooms", roomRouter);

app.get("/", async (req, res) => {
    res.send("success")
})


app.listen(port, () => {
    console.log(`Pear Program backend listening on port ${port}`)
})