import { ChatMessage, ChatMessageSection, ParticipantInfo } from "./constants"
import { getCodeHistoryOfRoom } from "./routes/rooms"
import { getConnection, makeQuery } from "./utils/database"

export default class Bruno {
    readonly roomId: string
    readonly condition: number // 1-4

    // Use this to send a message into the room
    readonly send: (message: ChatMessageSection[]) => Promise<void>
    readonly sendTypingStatus: (startTyping: boolean) => Promise<void>

    private currentChatHistory: ChatMessage[] = []
    
    /**
     * Called when Bruno has been added to a room. The room could either be newly created (in which case, the chat history would be empty), or restored from an existing session (in which case, the chat history is not empty). The latter situation happens when all participants have left a room and then someone joined back. The moment all participants leave a room, its Bruno instance is deallocated.
     * @param roomId The ID of the room.
     * @param send An asynchronous function for sending messages as Bruno into the room.
     */
    constructor(roomId: string, condition: number, chatHistory: ChatMessage[], send: (message: ChatMessageSection[]) => Promise<void>, sendTypingStatus: (startTyping: boolean) => Promise<void>) {
        this.roomId = roomId
        this.condition = condition
        this.send = send
        this.sendTypingStatus = sendTypingStatus
        this.currentChatHistory = chatHistory
        console.log(`Initialized Bruno instance (condition ${condition}) for room ${roomId}`)
    }

    async onParticipantsUpdated(participants: ParticipantInfo[]) {
        console.log(`Room ${this.roomId} received updated participant list`, participants)
        console.log("Current chat history length:", this.currentChatHistory.length)

        if (participants.length === 1 && this.currentChatHistory.filter(m => m.sender !== "system").length === 0) {
            const currentParticipant = participants[0]
            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: `Hi ${currentParticipant.name ?? "there"}! I am Bruno and will be your pair programming facilitator today.`}
            ])
            await sleep(1000)
            await this.send([
                {type: "text", value: "We are still waiting for one more person to join the session. In the meantime, can you tell me a little about yourself? Specifically:\n1. What assignment(s) have you been working on lately?\n2. How would you describe your coding level at this point?\n3. Are there any things you are hoping to get out of this session?"}
            ])
        }
    }

    /**
     * Will be called whenever the chat history has changed, except when Bruno is the one who sent a new message and triggered the chat history update.
     */
    async onChatHistoryUpdated(newChatHistory: ChatMessage[], eventType: "send_text" | "make_choice", eventInfo?: any) {
        console.log(`Received event ${eventType} in room ${this.roomId}`)
        console.log("Last message:", newChatHistory[newChatHistory.length - 1])
        this.currentChatHistory = newChatHistory

        if (eventType === "send_text") {
            const codeHistory = await getCodeHistoryOfRoom(this.roomId)
            // console.log("Latest state of code:", codeHistory[codeHistory.length - 1])
        }
    }

    async onUserMakesChoice(messageId: number, contentIndex: number, choiceIndex: number) {
        const section = this.currentChatHistory[messageId].content?.[contentIndex]
        if (section) {
            section.choice_index = choiceIndex
        }
        console.log(`User made choice: ${choiceIndex} for messageId ${messageId} contentIndex: ${contentIndex}`)
    }

    /**
     * Called when all participants left the room. The Bruno instance is automatically deallocated.
     */
    async onRoomClose() {
        console.log(`Destroying Bruno for room ${this.roomId}`)
    }
}

async function sleep(ms: number) {
    await new Promise((r, _) => setTimeout(r, ms))
}