import { Router } from "express";
import { admitQueue } from "../queue_system";
import { ACTIVE_MEETINGS } from "../zoom_participants";

const queueRouter = Router()

queueRouter.get("", async (req, res) => {
    const queue = admitQueue.getQueue()
    res.json(queue.map(q => {
        return {
            email: q.email,
            name: q.name
        }
    }))
})

queueRouter.get("/active_meetings", async (req, res) => {
    res.send(ACTIVE_MEETINGS)
})

export default queueRouter;