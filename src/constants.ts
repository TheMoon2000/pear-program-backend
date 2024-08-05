import axios from "axios"

// Root token
export const authHeader = { Authorization: "token 6b116b41b7c446c0910671f36c7abf47" }
export const hubInstance = axios.create({ baseURL: "http://172.17.0.2:8020/notebook/hub/api", headers: authHeader })
export const serverInstance = axios.create({ baseURL: "http://172.17.0.2:8020/notebook/user" })
export const recallInstance = axios.create({ baseURL: "https://us-west-2.recall.ai/api/v1", headers: {
    Authorization: `Token ${process.env.RECALL_API_KEY}`
} })
export const zoomInstance = axios.create({ baseURL: "https://api.zoom.us/v2" })

export interface ChatMessageSection {
    type: "text" | "choices",
    value: string | string[]
    choice_index?: number
}

export interface ChatMessage {
    sender: string
    name: string
    timestamp: string // ISO 8601 string
    message_id: number
    content?: ChatMessageSection[]
    system_message?: string
}

export interface RoomContext {
    roomId: string
    chatHistory: ChatMessage[]
    studentsOnline: ParticipantInfo[]
    snapshots: { timestamp: Date, code: string, author_map: string, question_id: string }
}

export interface ParticipantInfo {
    name: string
    id: number
    email: string
    isOnline: boolean
    role: number
}

export interface Snapshot {
    timestamp: Date
    code: string
    author_map: string
    question_id: string
}

export interface BrunoState {
    stage: number
    solvedQuestionIds: string[]
}