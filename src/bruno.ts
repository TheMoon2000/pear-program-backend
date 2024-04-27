import { ChatMessage, ChatMessageSection, ParticipantInfo } from "./constants"
import { getCodeHistoryOfRoom } from "./routes/rooms"

export default class Bruno {
    readonly roomId: string

    // Use this to send a message into the room
    readonly send: (message: ChatMessageSection[]) => Promise<void>
    
    /**
     * Called when Bruno has been added to a room. The room could either be newly created (in which case, the chat history would be empty), or restored from an existing session (in which case, the chat history is not empty). The latter situation happens when all participants have left a room and then someone joined back. The moment all participants leave a room, its Bruno instance is deallocated.
     * @param roomId The ID of the room.
     * @param send An asynchronous function for sending messages as Bruno into the room.
     */
    constructor(roomId: string, chatHistory: ChatMessage[], send: (message: ChatMessageSection[]) => Promise<void>) {
        this.roomId = roomId
        this.send = send
        console.log(`Initialized Bruno instance for room ${roomId}, resuming from chat history`, chatHistory)
    }

    async onParticipantsUpdated(participants: ParticipantInfo[]) {
        console.log(`Room ${this.roomId} received updated participant list`, participants)
    }

    /**
     * Will be called whenever the chat history has changed, except when Bruno is the one who sent a new message and triggered the chat history update.
     */
    async onChatHistoryUpdated(newChatHistory: ChatMessage[], eventType: "send_text" | "make_choice", eventInfo?: any) {
        console.log(`Received event ${eventType} in room ${this.roomId}`)
        console.log("Last message:", newChatHistory[newChatHistory.length - 1])

        if (eventType === "send_text") {
            const codeHistory = await getCodeHistoryOfRoom(this.roomId)
            console.log("Latest state of code:", codeHistory[codeHistory.length - 1])
        }
    }

    /**
     * Called when all participants left the room. The Bruno instance is automatically deallocated.
     */
    async onRoomClose() {
        console.log(`Destroying Bruno for room ${this.roomId}`)
    }
}