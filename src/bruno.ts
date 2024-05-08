import { sendEventOfType, sendNotificationToRoom } from "./chat"
import { ChatMessage, ChatMessageSection, ParticipantInfo, BrunoState } from "./constants"
import { getCodeHistoryOfRoom } from "./routes/rooms"
import { getConnection, makeQuery } from "./utils/database"
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from "openai/src/resources/index.js";

/* To Do Summary:
 + Implement Switching Roles Functionality in Turn Taking Intervention (Either GPT or Hard-Code)
 + Add Bruno When Only 1 Participant Is In The Room (???)
 + Handle Case When Both Participants Go Offline (Giving Bruno context might be useful if room reinstated later?)
 + Pause periodic function when one participant goes offline (?)
 + Switch all internal variables to dictionary state to send to Jerry
 + (Future) Calculate Conversation Data Metrics
*/

export default class Bruno {
    readonly roomId: string
    readonly condition: number // 1-4

    periodicFunctionInstance?: NodeJS.Timeout

    // Use this to send a message into the room
    readonly send: (message: ChatMessageSection[]) => Promise<void>
    readonly sendTypingStatus: (startTyping: boolean) => Promise<void>

    private currentChatHistory: ChatMessage[] = []

    private openai = new OpenAI({
        apiKey:
          process.env.OPENAI_API_KEY
      });
    
    private brunoMessages: ChatCompletionMessageParam[] = []
    
    private interventionSpecificMessages: ChatCompletionMessageParam[] = [];

    private participantData: ParticipantInfo[] = [];

    private bothParticipantsJoined: boolean

    private bothParticipantsOnline: boolean

    private introductionFlag: boolean

    private participantNames: string[] = []

    private periodicFunctionStarted: boolean

    private state: BrunoState

    private initialPrompt =
      "You are Bruno. You are a mentor for the Code in Place project, which is a free intro-to-coding course from Stanford University that is taught online. The Code in Place project recruits and trains one volunteer teacher for every students in order to maintain a proportional ratio of students to teachers. \n \
          \
          Code in Place is now piloting a Pair Programming feature, where two students are paired up to work together on an assignment. As a mentor, your role is to guide these students through the pair programming process and help them work together. Your job also involves assessing the students' individual contributions to the assignment in terms of code written and involvement in conversations or brainstorming. You perform this assessment by looking at metrics provided to you by the shared coding environment the students are using. Wait to assess the students until you have been provided metrics from this software--the metrics will be tagged [METRIC]. \n \
          \
          The Code in Place software will provide you similar tags. Only assess the students once you have received these tagged messages. \n \
          \
          There are currently 0 students in the coding environment. You will be notified once one (or both) students have joined. \n \
          \
          Do not number or label your messages. Do not break character or mention that you are an AI Language Model.";
  
    /**
     * Called when Bruno has been added to a room. The room could either be newly created (in which case, the chat history would be empty), or restored from an existing session (in which case, the chat history is not empty). The latter situation happens when all participants have left a room and then someone joined back. The moment all participants leave a room, its Bruno instance is deallocated.
     * @param roomId The ID of the room.
     * @param send An asynchronous function for sending messages as Bruno into the room.
     */
    constructor(roomId: string, condition: number, chatHistory: ChatMessage[], send: (message: ChatMessageSection[]) => Promise<void>, sendTypingStatus: (startTyping: boolean) => Promise<void>, savedState?: BrunoState) {
        this.roomId = roomId
        this.condition = condition
        this.send = send
        this.sendTypingStatus = sendTypingStatus
        this.currentChatHistory = chatHistory
        this.brunoMessages = [{role: "system", content: this.initialPrompt}]  // Modify later to account for room restored from existing session
        this.interventionSpecificMessages = [
            { role: "system", content: this.initialPrompt },
          ];
        this.bothParticipantsJoined = false  // True when both participants join for the first time
        this.bothParticipantsOnline = false
        this.introductionFlag = false
        this.periodicFunctionStarted = false

        this.state = savedState ?? {stage: 0}

        console.log(`Initialized Bruno instance (condition ${condition}) for room ${roomId}`)
    }

    async intersubjectivityIntervention(participants: ParticipantInfo[]){
        const codeHistory = await getCodeHistoryOfRoom(this.roomId)

        var chunkSize = 10

        //If code history longer than designated chunkSize
        if (codeHistory.length > 0 && codeHistory[codeHistory.length - 1].author_map.length > chunkSize) {
            var code = codeHistory[codeHistory.length - 1].author_map.replace(/[?]/g, "")

            var numNewLines = code.match(/\n/g)?.length || -1

            var newLineIndices: Number[] = [] 
            for (let i = 0; i < code.length; i++) {
                if (code[i] === "\n") {
                    newLineIndices.push(i)
                }
            }

            var firstNewLine = 0
            var lastNewLine = chunkSize

            var chunkNotFound = true
            var chunkWriter = ""


            // TO DO: Will repeat the same chunk, need to remember which chunks have already been looked at
            while ((lastNewLine < numNewLines - 1) && chunkNotFound) {
                var codePercentages = await this.getCodeContribution(code.substring(firstNewLine, lastNewLine))
                if (parseFloat(codePercentages[0]) >= 70) {
                    chunkWriter = participants[0].name
                    chunkNotFound = false
                }
                else if (parseFloat(codePercentages[1]) >= 70) {
                    chunkWriter = participants[1].name
                    chunkNotFound = false
                } else {
                    firstNewLine = firstNewLine + 1
                    lastNewLine = lastNewLine + 1
                }
            }
            
            this.interventionSpecificMessages.push({
                role: "system",
                content: `There is a large chunk of code from lines ${firstNewLine} to ${lastNewLine} written predominantly by ${chunkWriter}. Encourage ${chunkWriter} to explain those specific lines of code to their partner. 
                        Follow-up with the partner to ensure that they understand`,
            });
            // await this.gpt();
            await this.gptLimitedContext();
            this.interventionSpecificMessages.pop();
        }
    }

    // Implement switch roles functionality
    async turnTakingIntervention(participants: ParticipantInfo[]){     
        var talkPercentages = await this.getConversationContribution()
        var aTalkPercentage = talkPercentages[0];
        var bTalkPercentage = talkPercentages[1];

        var codeContributions = await this.getCodeContribution()
        var codePercentageA = codeContributions[0]
        var codePercentageB = codeContributions[1]

        var role1Goal = " should be writing the majority of the code and contributing less to the conversations. "
        var role2Goal = " should verbally contribute to the majority of the conversation and contribute less to writing the code. "
        var role1, role2 = ""
        if (participants[0].role == 0) {
            role1 = "[DRIVER]"
            role2 = "[NAVIGATOR]"
        }
        else {
            role1 = "[DRIVER]"
            role2 = "[NAVIGATOR]"
            var temp = role2Goal
            role2Goal = role1Goal
            role1Goal = temp
        }

        this.interventionSpecificMessages.push({
            role: "system",
            content: `${participants[0].name} has the ${role1} while ${participants[1].name} has the ${role2} role. Because ${participants[0].name} has the ${role1} role, ${participants[0].name} ${role1Goal}
                    Because ${participants[1].name} has the ${role2} role, ${participants[1].name} ${role2Goal}
                    Evaluate ${participants[0].name} and ${participants[1].name} based on how well they are fulfilling their respective roles. If they are not fulfilling their roles properly, explain how they can do better to fulfill the specific roles that they have been assigned. If they have properly fulfilled their roles, praise the students.",`,
          });
          this.interventionSpecificMessages.push({
            role: "system",
            content: `New metric data. Remember, the students should switch roles IF AND ONLY IF they have properly fulfilled their currently assigned roles. 
                      \n[METRIC] ${participants[0].name}: ${codePercentageA}% Code
                      \n[METRIC] ${participants[1].name}: ${codePercentageB}% Code
                      
                      \n[METRIC] ${participants[0].name}: ${aTalkPercentage}% Contribution to Conversation
                      \n[METRIC] ${participants[1].name}: ${bTalkPercentage}% Contribution to Conversation`,
          });
          // await this.gpt();
          await this.gptLimitedContext();
          this.interventionSpecificMessages.pop();
          this.interventionSpecificMessages.pop();
    }

    async talkTimeIntervention(participants: ParticipantInfo[]){
        var talkPercentages = await this.getConversationContribution()
        var aTalkPercentage = talkPercentages[0];
        var bTalkPercentage = talkPercentages[1];
      
        this.interventionSpecificMessages.push({
            role: "system",
            content:
              "If you determine one student is contributing relatively less, you should guide the students and provide specific, constructive feedback to share a more even workload. For instance, if the software provides you the following metrics: \n \
              [METRIC] Student A: 20% Conversation \n \
              [METRIC] Student B: 80% Conversation \n \
              \
              You should encourage Student A to participate more in the conversation. Note that the above metrics are only an example and should not be used. The Code in Place software will provide you similar tags. Only assess the students once you have received these tagged messages.",
          });
          this.interventionSpecificMessages.push({
            role: "system",
            content: `\n[METRIC] ${participants[0].name}: ${aTalkPercentage}% Contribution to Conversation
                      \n[METRIC] ${participants[1].name}: ${bTalkPercentage}% Contribution to Conversation`,
          });
          // await this.gpt();
          await this.gptLimitedContext();
          this.interventionSpecificMessages.pop;
    }

    async getConversationContribution(): Promise<[string, string]> {
        // harcode something
        return ["80","20"]
    }

    async getCodeContribution(specificCode?: string): Promise<[string, string]> {
        if (specificCode != null) {
            var code = specificCode.replace(/[?\n]/g, "")
        }
        else {
            const codeHistory = await getCodeHistoryOfRoom(this.roomId)
            if (codeHistory[codeHistory.length - 1].author_map.length > 0) {
                var code = codeHistory[codeHistory.length - 1].author_map.replace(/[?\n]/g, "")
            }
            else {
                return ["0","0"]
            }
        }
        return [((code.match(/0/g) || "").length / code.length * 100).toFixed(2), ((code.match(/1/g) || "").length / code.length * 100).toFixed(2)]
    }
    // Runs every 5 minutes
    async periodicFunction(participants: ParticipantInfo[]) {
        if (this.condition === 0) {
            await this.talkTimeIntervention(participants)
        }
        else if (this.condition === 1) { await this.turnTakingIntervention(participants)}
        else if (this.condition === 2) { await this.intersubjectivityIntervention(participants)}
    }

    // Query GPT w/ limited context and display response in chat room
    async gptLimitedContext() {
        const completion = await this.openai.chat.completions.create({
        messages: this.interventionSpecificMessages,
        model: "gpt-3.5-turbo",
        });

        //Maybe Delete
        this.brunoMessages.push({
        role: "system",
        content:
            "You have been provided metrics and were asked to evaluate the students. The following response is your analysis:",
        });
        this.brunoMessages.push(completion.choices[0].message);

        await this.sendTypingStatus(true);
        await sleep(1000);
        await this.sendTypingStatus(false);
        await this.send([
        { type: "text", value: completion.choices[0].message.content || "" },
        ]);
    }


    //TO DO: Fix try/catch to account for rate limit issue (exponential backoff)
    async gpt() {
        try {
            const completion = await this.openai.chat.completions.create({
                messages: this.brunoMessages,
                model: "gpt-3.5-turbo",
            });

            this.brunoMessages.push(completion.choices[0].message);

            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: completion.choices[0].message.content || ""}
            ])
        }
        catch{

        }
}

    async onParticipantsUpdated(participants: ParticipantInfo[]) {
        console.log(`Room ${this.roomId} received updated participant list`, participants)
        console.log("Current chat history length:", this.currentChatHistory.length)

        this.participantData = JSON.parse(JSON.stringify(participants));

        // NEED TO FIGURE THIS OUT
        if (participants.length === 1 && this.currentChatHistory.filter(m => m.sender !== "system").length === 0) {
            const currentParticipant = participants[0]
            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)

            // TODO: Add Bruno Here
            await this.send([
                {type: "text", value: "We are still waiting for one more person to join the session. In the meantime, let's get you set up."}
            ])
            await sleep(1000)

            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: "Remember to allow video and audio access. \n\nThe \"Show Video\" button will allow you to see your partner once they join. \n\nThe session will begin once another participant joins the room."}
            ])
            await sleep(1000)
        }

        else if (participants.length === 2 && (participants[0].isOnline === true && participants[1].isOnline === true)) {
            if (this.state.stage === 0) {
                // Arbitrarily set participant 1 to role 1 and participant 2 to role 2
                let conn = await getConnection()
                await makeQuery(conn, "UPDATE Participants SET role = 1 WHERE room_id = ? AND user_email = ?", [this.roomId, participants[0].email])
                await makeQuery(conn, "UPDATE Participants SET role = 2 WHERE room_id = ? AND user_email = ?", [this.roomId, participants[1].email])

                this.participantNames[0] = participants[0].name
                this.participantNames[1] = participants[1].name

                this.brunoMessages.push({
                    role: "system",
                    content: `Both students are in the session. Student A's name is ${participants[0].name}. Student B's name is ${participants[1].name}.`,

                });

                //INTERVENTION SPECIFIC
                this.interventionSpecificMessages.push({
                    role: "system",
                    content: `Both students are in the session. Student A's name is ${participants[0].name}. Student B's name is ${participants[1].name}.`,
                });

                await this.sendTypingStatus(true)
                await sleep(1000)
                await this.sendTypingStatus(false)
                await this.send([
                    {type: "text", value: "Hi, I'm Bruno your pair programming facillitator. I'm here to help you get the most out of this session."}
                ])
                await sleep(1000)

                await this.send([
                    {type: "text", value: "Before we begin, take a moment to introduce yourself to your partner. Let me know once you are done."},
                    {type: "choices", value: ["Ready"]}
                ])

                this.bothParticipantsJoined = true
                this.bothParticipantsOnline = true
                conn.release()

                this.state.stage = 1
                await this.saveState()

            }
            else if (!this.bothParticipantsOnline) {  // If one participant was previously offline and now both are online, restart periodic function
                this.periodicFunctionInstance = setInterval(()=>this.periodicFunction(participants), 5 * 60 * 1000)
                this.bothParticipantsOnline = true
            }
        }

        // BRUNO DOES NOT KNOW WHEN A PARTICIPANT HAS LEFT. PERIODIC FUNCTIONS ARE RESET
        else if (participants.length === 2 && (participants[0].isOnline !== true || participants[1].isOnline !== true)) {  // If not every participant is online
            var studentName = ""
            if (participants[0].isOnline !== true) {
                studentName = participants[0].name
            }
            else if (participants[1].isOnline !== true) {
                studentName = participants[1].name
            }
            
            if (studentName !== ""){
                await this.send([{type: "text", value: studentName + " is currently offline. You can wait for " + studentName + " to rejoin or click the button below to join a new coding session."}])
                // this.brunoMessages.push({role: "system", content: studentName + " is currently offline. There is currently one student remaining in the room"})
                await this.send([
                    {type: "text", value: "Note: All coding progress will be lost if you join a new coding session! Save your code elsewhere (e.g. in notepad) if you would like to transfer your progress."},
                    {type: "choices", value: ["Join New Coding Session [Currently Non-Functional]"]}
                ])
                // TODO: pause periodic function instead of clearing?
                this.bothParticipantsOnline = false
                clearInterval(this.periodicFunctionInstance)
            }
            // TODO: handle case where both participants go offline?
        }
        // }
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
            console.log("Latest state of code:", codeHistory[codeHistory.length - 1])

            // WHEN USER SENDS MESSAGE IN CHAT, SEND QUERY TO GPT AND OUTPUT RESPONSE
            // this.brunoMessages.push({
            //     role: "user",
            //     content: newChatHistory[newChatHistory.length - 1].content,
            // });
            // await this.gpt();
        }
    }

    async onUserMakesChoice(messageId: number, contentIndex: number, choiceIndex: number) {
        const section = this.currentChatHistory[messageId].content?.[contentIndex]
        if (section) {
            section.choice_index = choiceIndex
        }
        console.log(`User made choice: ${choiceIndex} for messageId ${messageId} contentIndex: ${contentIndex}`)

        if (this.state.stage === 1) {
            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: "Great. Here's some information on how to pair program effectively: " } ])
            await sleep(1000)

            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: "Why Pair Programing? [Text]" } ])
            await sleep(1000)

            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: "Learn Goals of Pair Programming [Text]" } ])
            await sleep(1000)

            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([
                {type: "text", value: "How to Pair Program [Text]" } ])
            await sleep(1000)

            if (this.condition === 1) {
                await this.send([
                    {type: "text", value: `${this.participantNames[0]} has been assigned the "Driver" role. This role involves [explain role]. \n\n${this.participantNames[1]} has been assigned the "Navigator" role. This role involves [explain role].`}
                ])}

            let conn = await getConnection()
            const [questions] = await makeQuery(conn, "SELECT question_id, title FROM TestCases")
            await this.send([
                {type: "text", value: "When you are ready, you can select the problem that you would like to work on."},
                {type: "choices", value: questions.map((q:any) => q.title)}
            ])
            this.introductionFlag = true
            conn.release()

            this.state.stage = 2
            await this.saveState()

        }

        else if (this.state.stage === 2) {
            const conn = await getConnection() 
            const [testCase] = await makeQuery(conn, "SELECT * FROM TestCases LIMIT ?, 1", [choiceIndex])

            if (testCase.length === 0) {
                console.warn("Selected test case not found")
            } else {
                const author_map = testCase[0].starter_code.replace(/[^\n]/g, "?")
                const [room] = await makeQuery(conn, "UPDATE Rooms SET code = ?, author_map = ?, question_id = ? WHERE id = ?", [testCase[0].starter_code, author_map, testCase[0].question_id, this.roomId])
                if (room.affectedRows === 0) {
                    console.warn("Room not found!")
                } else {
                    await sendNotificationToRoom(this.roomId, `Bruno has pulled up the coding problem '${testCase[0].title}'.`)
                    await sendEventOfType(this.roomId, "question_update", "AI", {"question": testCase[0]})
                }
            }

            this.periodicFunctionInstance = setInterval(()=>this.periodicFunction(this.participantData), 5 * 60 * 1000)
            this.brunoMessages.push({
                role: "system",
                content: "The students have selected the problem they want to work on and have begun coding. Do not greet them."
            });

            //INTERVENTION SPECIFIC
            this.interventionSpecificMessages.push({
                role: "system",
                content: "The students have selected the problem they want to work on and have begun coding. Do not greet them."
            });
            // await this.gpt()
            this.periodicFunctionStarted = true

            this.state.stage = 3
            await this.saveState()
            conn.release()

        }    
    }

    /**
     * Called when all participants left the room. The Bruno instance is automatically deallocated.
     */
    async onRoomClose() {
        console.log(`Destroying Bruno for room ${this.roomId}`)
    }

    /** Save current state to database. */
    async saveState() {
        const conn = await getConnection()
        await makeQuery(conn, "UPDATE Rooms SET bruno_state = ? WHERE id = ?", [JSON.stringify(this.state), this.roomId])
        conn.release()
    }
}

async function sleep(ms: number) {
    await new Promise((r, _) => setTimeout(r, ms))
}