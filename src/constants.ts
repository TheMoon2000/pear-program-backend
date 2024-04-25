import axios from "axios"

// Root token
export const authHeader = { Authorization: "token 6b116b41b7c446c0910671f36c7abf47" }
export const hubInstance = axios.create({ baseURL: "http://172.17.0.2:8020/notebook/hub/api", headers: authHeader })
export const serverInstance = axios.create({ baseURL: "http://172.17.0.2:8020/notebook/user" })

export interface ChatMessage {
    sender: string
    timestamp: string // ISO 8601 string
    message_id: number
    content: {
        type: "text" | "choices",
        value: string | string[]
        choice_index?: number
    }[]
}
