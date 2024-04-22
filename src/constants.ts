import axios from "axios"

// Root token
export const authHeader = { Authorization: "token 0b1f6b5b4f6246a79d272b15d83f5481" }
export const hubInstance = axios.create({ baseURL: "http://172.17.0.2:8020/notebook/hub/api", headers: authHeader })
export const serverInstance = axios.create({ baseURL: "http://172.17.0.2:8020/notebook/user" })
