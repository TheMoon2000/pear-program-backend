import { Router } from "express"
import crypto from "crypto"
import { Mutex } from "async-mutex";
import { ACTIVE_BOTS, ACTIVE_PARTICIPANTS, ACTIVE_MEETINGS, ZOOM_HOSTS } from "../zoom_participants";
import { recallInstance, zoomInstance } from "../constants";
import { getZoomAccessToken } from "./rooms";
import { socketMap } from "../chat";
import { getConnection, makeQuery } from "../utils/database";

const webhookRouter = Router()

const participantMutex = new Mutex()

export const onePersonBotTimeouts = new Map<string, NodeJS.Timeout>()
export const emptyMeetingBotTimeouts = new Map<string, NodeJS.Timeout>()
export const meetingCloseTimeouts = new Map<string, NodeJS.Timeout>()

const ONE_PERSON_BOT_WAIT = 600 // recall.ai bot leaves automatically after the zoom meeting only has 1 person for this number of seconds
const EMPTY_MEETING_CLOSE_TIMEOUT = 60 // meetings automatically close after being empty for this number of seconds
const EMPTY_MEETING_BOT_LEAVE_TIMEOUT = 60 // recall.ai bot leaves automatically after all users left the zoom meeting for this number of seconds
export const UNUSED_MEETING_TIMEOUT = 120 // meeting closes after being unused for this number of seconds
export const IDLE_WAIT_TIMEOUT = 30 // meeting closes after the only participant in a PearProgram session left for this number of seconds

webhookRouter.post("/transcription", async (req, res) => {
    if (!req.body?.data?.transcript) {
        return res.status(400).send()
    }

    /*
    {
        event: 'bot.transcription',
        data: {
            bot_id: 'a64e6c44-5ed6-447e-8d68-e6c4c3f722dd',
            recording_id: 'e652a0c6-02cd-4e90-9cfe-2ed06ef8baec',
            transcript: {
            original_transcript_id: 1,
            speaker: 'Jerry Shan',
            speaker_id: 16778240,
            words: [
                {
                    text: "Executive is gonna, we're connected to chat you here or something. And you can't get that.",
                    start_time: 203.74098,
                    end_time: 209.25305
                }
            ],
            is_final: true,
            language: 'en',
            source: 'meeting_captions'
            }
        }
    }
    */

    const botId = req.body.data.bot_id
    // console.log(`${botId} received transcription`, req.body.data)

    res.send()
})

webhookRouter.all("/zoom", async (req, res) => {
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`
    const hashForVerify = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN!).update(message).digest('hex')
    // hash the message string with your Webhook Secret Token and prepend the version semantic
    const signature = `v0=${hashForVerify}`

    if (req.headers['x-zm-signature'] === signature) {
        if (req.body.event === 'endpoint.url_validation') {
            const hashForValidate = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN!).update(req.body.payload.plainToken).digest('hex')
      
            res.json({
                plainToken: req.body.payload.plainToken,
                encryptedToken: hashForValidate
            })
            console.log("Received zoom verification request", req.body)
        } else {
            await participantMutex.acquire()

            const accessToken = await getZoomAccessToken()
            const meetingId = req.body.payload.object.id as string
            const meetingInfo = await zoomInstance.get(`/meetings/${meetingId}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            })
            const roomId = meetingInfo.data.agenda as string
            const hostIndex = ZOOM_HOSTS.indexOf(meetingInfo.data.host_email)
            if (hostIndex === -1) { return res.send() } // Ignore activity in all zoom accounts that are not included in ZOOM_HOSTS

            if (req.body?.event === "meeting.participant_joined") {
                const participantObject = req.body.payload.object.participant
                
                // Whenever a participant joins, we cancel the existing inactivity timer
                clearTimeout(meetingCloseTimeouts.get(meetingId))
                meetingCloseTimeouts.delete(meetingId)

                if (participantObject.email.startsWith("user")) {
                    if (!ACTIVE_PARTICIPANTS.has(meetingId)) {
                        ACTIVE_PARTICIPANTS.set(meetingId, [])
                    }
                    const existing = ACTIVE_PARTICIPANTS.get(meetingId)?.find(p => p.registrant_id === participantObject.registrant_id)
                    if (!existing) {
                        ACTIVE_PARTICIPANTS.get(meetingId)?.push({
                            registrant_id: participantObject.registrant_id,
                            username: participantObject.user_name,
                            email: participantObject.email,
                            roomId: roomId
                        })
    
                        // If the participant count reaches 2 and no bot is in the room right now, dispatch a new bot
                        if (ACTIVE_PARTICIPANTS.get(meetingId)!.length >= 2 && !ACTIVE_BOTS.has(meetingId)) {
                            // Invite the bot to the zoom meeting as a registrant
                            const addRegistrantResponse = await zoomInstance.post(`https://api.zoom.us/v2/meetings/${meetingId}/registrants`, {
                                first_name: "PearProgram",
                                last_name: "Bot",
                                email: `bot-${meetingId}@pearprogram.co`
                            }, {
                                headers: { Authorization: `Bearer ${accessToken}` }
                            })
                            
                            // add bot
                            const createBotResponse = await recallInstance.post("/bot", {
                                transcription_options: {
                                    provider: "meeting_captions"
                                },
                                meeting_url: addRegistrantResponse.data.join_url,
                                real_time_transcription: {
                                    destination_url: "https://pearprogram.co/api/webhooks/transcription"
                                },
                                bot_name: "PearProgram Bot",
                                automatic_leave: {
                                    everyone_left_timeout: EMPTY_MEETING_BOT_LEAVE_TIMEOUT
                                },
                                zoom: {
                                    user_email: `bot-${meetingId}@pearprogram.co`
                                }
                            })
                            ACTIVE_BOTS.set(meetingId, createBotResponse.data.id)
                            console.log(`Injected bot ${createBotResponse.data.id} to zoom meeting ${meetingId}`)
                        }
                        socketMap.get(roomId)?.ai.onZoomParticipantUpdated()
                    }
                } else if (participantObject.email.startsWith("bot")) {
                    // The meeting's agenda is the PearProgram session ID
                    const meetingInfo = await zoomInstance.get(`/meetings/${meetingId}`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    })
                    const roomId = meetingInfo.data.agenda as string
                    const bruno = socketMap.get(roomId)?.ai
                    if (bruno && ACTIVE_BOTS.has(meetingId)) {
                        bruno.onBotEnteredZoom(ACTIVE_BOTS.get(meetingId)!)
                    } else if (!bruno) {
                        console.warn(`WARNING: did not find Bruno instance for room ${roomId}!!`)
                    } else {
                        console.warn(`Bot with email ${participantObject.email} is unidentified!`)
                    }
                }
            } else if (req.body?.event === "meeting.participant_left") {
                const meetingId = req.body.payload.object.id as string
                const participantObject = req.body.payload.object.participant
                const deleteIndex = ACTIVE_PARTICIPANTS.get(meetingId)?.findIndex(info => info.registrant_id === participantObject.registrant_id)
                if (typeof deleteIndex === "number" && deleteIndex !== -1) {
                    ACTIVE_PARTICIPANTS.get(meetingId)?.splice(deleteIndex, 1)
                    if (ACTIVE_PARTICIPANTS.get(meetingId)?.length === 0) {
                        ACTIVE_PARTICIPANTS.delete(meetingId)
                        
                        // Initiate meeting close timeout
                        clearTimeout(meetingCloseTimeouts.get(meetingId))
                        meetingCloseTimeouts.set(meetingId, setTimeout(async () => {
                            const bruno = socketMap.get(roomId)?.ai
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
                            await makeQuery(conn, "UPDATE Participants SET zoom_url = null WHERE room_id = ?", [roomId])
                            await makeQuery(conn, "UPDATE Rooms SET meeting_expired = 1 WHERE id = ?", [roomId])
                            conn.release()

                            // Make the host available again
                            if (ACTIVE_MEETINGS[hostIndex] === meetingId) {
                                ACTIVE_MEETINGS[hostIndex] = null
                            }

                            console.log(`Auto-closed zoom meeting ${meetingId} for room ${roomId}`)
                        }, EMPTY_MEETING_CLOSE_TIMEOUT * 1000))
                    } else if (ACTIVE_PARTICIPANTS.get(meetingId)?.length === 1) {
                        // 10min bot timeout
                        clearTimeout(onePersonBotTimeouts.get(meetingId))
                        onePersonBotTimeouts.set(meetingId, setTimeout(() => {
                            const botId = ACTIVE_BOTS.get(meetingId)
                            if (botId) {
                                recallInstance.post(`/bot/${botId}/leave_call`).catch(err => {
                                    console.warn(err)
                                }).finally(() => {
                                    ACTIVE_BOTS.delete(meetingId)
                                    onePersonBotTimeouts.delete(meetingId)
                                })
                            }
                        }, ONE_PERSON_BOT_WAIT * 1000))
                    }
                    socketMap.get(roomId)?.ai.onZoomParticipantUpdated()
                } else if (participantObject.email.startsWith("bot")) {
                    const bruno = socketMap.get(roomId)?.ai
                    if (bruno && ACTIVE_BOTS.has(meetingId)) {
                        bruno.onBotLeftZoom(ACTIVE_BOTS.get(meetingId)!)
                        ACTIVE_BOTS.delete(meetingId)
                    }
                }

            }
            participantMutex.release()

            res.send()
        }
    }

    res.send()
})

export default webhookRouter;