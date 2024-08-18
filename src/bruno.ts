import axios from "axios";
import { sendEventOfType, sendNotificationToRoom } from "./chat"
import { ChatMessage, ChatMessageSection, ParticipantInfo, BrunoState, recallInstance } from "./constants"
import { getCodeHistoryOfRoom } from "./routes/rooms"
import { getConnection, makeQuery } from "./utils/database"
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from "openai/src/resources/index.js";
import { ACTIVE_PARTICIPANTS } from "./zoom_participants";
import { intersubjectivity } from "./utils/intersubjectivity";

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
    readonly send: (message: ChatMessageSection[]) => Promise<number>
    readonly sendTypingStatus: (startTyping: boolean) => Promise<void>

    private currentChatHistory: ChatMessage[] = []

    private openai = new OpenAI({
        apiKey:
          process.env.OPENAI_API_KEY
      });
    
    // private brunoMessages: ChatCompletionMessageParam[] = []
    
    private interventionSpecificMessages: ChatCompletionMessageParam[] = [];
    private participantData: ParticipantInfo[] = [];

    // private bothParticipantsJoined: boolean

    private bothParticipantsOnline: boolean

    // private introductionFlag: boolean

    private participantNames: string[] = ["",""]

    // private periodicFunctionStarted: boolean

    private recallBotId?: string
    private onePersonExitReminder?: NodeJS.Timeout
    private previousZoomParticipantCount = 0
    meetingHost?: string // for expired meetings, this field will be undefined
    meetingId?: string // for expired meetings, this field will be undefined

    private state: BrunoState

    private numRoleSwitches: number

    private periodLength = 5 // TODO: 10

    //Last line of previous chunk
    // private chunkHistory = -1

    // number of students in prompt
    private initialPrompt = "You are Bruno. You are a mentor for the Code in Place project, which is a free intro-to-coding course from Stanford University that is taught online. The Code in Place project recruits and trains one volunteer teacher for every students in order to maintain a proportional ratio of students to teachers. \n \
                            \ Code in Place is now piloting a Pair Programming feature, where two students are paired up to work together on an assignment. As a mentor, your role is to guide these students through the pair programming process and help them work together. Your job also involves assessing the students' individual contributions to the assignment in terms of code written and involvement in conversations or brainstorming. You perform this assessment by looking at metrics provided to you by the shared coding environment the students are using. \n \
                            \ Do not number or label your messages. Do not break character or mention that you are an AI Language Model.";


    private autograderSystemPrompt = `You are an expert grader from Stanford University who is grading students in a open access intro python course. 
    Please grade this student's work and return the grade in a JSON of this format:
    {
    "score": an integer from 0-10,
    "feedback": [
        {
            "error":,
            "how_to_fix":,
            "rank":,
        },
        {
            "error":,
            "how_to_fix":,
            "rank":,
        }
    ]
    }
    You will be given a description of the question, the starter code, a student's code and a few expert graded examples. Output ONLY the JSON.
    In your output JSON, you should assign the student a score from 0-10, with 10 being perfect. 
    In the "feedback" section of the JSON, list all errors that you find with the code. Ignore comments that contain "TODO".
    Format each error as an individual JSON object as above.
    Rank the errors by severity, with the highest number being the most severe impact to the functionality. 
    In a friendly, helpful manner, suggest how to fix each error.  

    Do not give feedback on style unless the score is perfect and the code is functional. 
    
    Many assignments will have constants, often in all caps camel case such as CANVAS_WIDTH. DO NOT DEDUCT FROM THEIR SCORE IF THEY CHANGE THESE CONSTANTS. That is fine, and normal.

    Graphics programs are written in a library that is a subclass off of tkinter. Importantly it does not require graphics.mainloop() to be called.
    
    Grade generously. Be much more concerned about conceptual mistakes, rather than small details.`                            

    private localAuthorMap: Map<number, number> = new Map<number, number>();
  
    /**
     * Called when Bruno has been added to a room. The room could either be newly created (in which case, the chat history would be empty), or restored from an existing session (in which case, the chat history is not empty). The latter situation happens when all participants have left a room and then someone joined back. The moment all participants leave a room, its Bruno instance is deallocated.
     * @param roomId The ID of the room.
     * @param send An asynchronous function for sending messages as Bruno into the room.
     */
    constructor(roomId: string, condition: number, chatHistory: ChatMessage[], send: (message: ChatMessageSection[]) => Promise<number>, sendTypingStatus: (startTyping: boolean) => Promise<void>, meetingHost: string | undefined, meetingId: string | undefined, savedState?: BrunoState) {
        this.roomId = roomId
        this.condition = condition
        this.send = send
        this.sendTypingStatus = sendTypingStatus
        this.currentChatHistory = chatHistory
        this.meetingHost = meetingHost
        this.meetingId = meetingId
        // this.brunoMessages = [{role: "system", content: this.initialPrompt}]  // Modify later to account for room restored from existing session
        this.interventionSpecificMessages = [
            { role: "system", content: this.initialPrompt },
          ];
        // this.bothParticipantsJoined = false  // True when both participants join for the first time
        this.bothParticipantsOnline = false
        // this.introductionFlag = false
        // this.periodicFunctionStarted = false
        this.numRoleSwitches = 0
        this.state = savedState ?? {stage: 0, solvedQuestionIds: []}
        console.log(`Initialized Bruno instance (condition ${condition}) for room ${roomId}, meeting host ${meetingHost}, id ${meetingId}`)
    }

    async intersubjectivityIntervention(participants: ParticipantInfo[]) {
        const codeHistory = await getCodeHistoryOfRoom(this.roomId)
        if (codeHistory.length === 0) { return }

        const conn = await getConnection()
        const [roomInfo] = await makeQuery(conn, "SELECT intersubjectivity_explainer FROM Rooms WHERE id = ?", [this.roomId])
        let explainer: 0 | 1 = roomInfo[0].intersubjectivity_explainer ?? 0
        explainer = 1 - explainer as (0 | 1) // switch
        let chunk = intersubjectivity(codeHistory.at(-1)!.code, codeHistory.at(-1)!.author_map, explainer)
        if (!chunk) {
            // switch back and try again
            explainer = 1 - explainer as (0 | 1)
            chunk = intersubjectivity(codeHistory.at(-1)!.code, codeHistory.at(-1)!.author_map, explainer)
            console.log("[Intersubjectivity] did not switch explainer because the other person didn't write enough code")
        }

        if (chunk) { // this means we found a range of code for the explainer to explain
            this.interventionSpecificMessages.push({
                role: "system",
                content: `There is a large chunk of code from lines ${chunk.startIndex + 1} to ${chunk.endIndex + 1} written predominantly by ${participants[1 - explainer].name}. Have ${participants[explainer].name} demonstrate their understanding of the code that ${participants[1 - explainer].name} wrote
                        by explaining those specific lines of code to their partner.`,
            });
            // await this.gpt();
            await this.gptLimitedContext();
            this.interventionSpecificMessages.pop();
            
            await makeQuery(conn, "UPDATE Rooms SET intersubjectivity_explainer = ? WHERE id = ?", [explainer, this.roomId])
            console.log(`Explainer for room ${this.roomId} switched to ${explainer}`)
        } else {
            console.log(`[Intersubjectivity] skipped room ${this.roomId} at ${new Date()} because no one has a chunk for the other to explain`)
        }
        
    }

    async onRoleSwitch() {
        // Only runs if room condition is 1 (turn taking intervention room)
        if (this.condition === 1 && this.bothParticipantsOnline) { 
            clearInterval(this.periodicFunctionInstance)
            this.periodicFunctionInstance = setInterval(()=>this.periodicFunction(this.participantData), this.periodLength * 60 * 1000)
        }
    }

    async getNumSwitches() {
        //get numswitches from database
        return 0
    }

    properlyFulfilledRoles(driverCode: number, navigatorTalk: number) {
        var threshold = 70
        if (driverCode < threshold || navigatorTalk < threshold) {
            return false
        }
        return true
    }

    // Function only called when students haven't switched in the past 10 minutes
    async turnTakingIntervention(participants: ParticipantInfo[]){
        // var databaseNumSwitches = await this.getNumSwitches() 
        // var numSwitches = databaseNumSwitches - this.numRoleSwitches           
        
        if (participants[0].role != 0 && participants[1].role != 0) {
            var talkPercentages = await this.getTimeContribution()
    
            var codeContributions = await this.getCodeContribution()
            var codePercentageA = codeContributions[0]
            var codePercentageB = codeContributions[1]
    
            var role1, role2, role1Goal, role2Goal, role1Metric, role2Metric = ""
            var fulfilledRoles = false
            const currentParticipantTalkTime = (talkPercentages[participants[0].name] ?? 0)
            if (participants[0].role == 1) {
                role1 = "[DRIVER]"
                role2 = "[NAVIGATOR]"

                role1Goal = " should be writing the majority of the code. ";
                role2Goal = " should be the main contributor to the conversation. ";

                role1Metric = codePercentageA + "% Code Written"
                role2Metric = 100 - currentParticipantTalkTime + "% Participation in Conversation"

                fulfilledRoles = this.properlyFulfilledRoles(codePercentageA, 100 - currentParticipantTalkTime)
            }
            else if (participants[0].role == 2) {
                role1 = "[NAVIGATOR]"
                role2 = "[DRIVER]"

                role1Goal = " should be the main contributor to the conversation. ";
                role2Goal = " should be writing the majority of the code. ";

                role1Metric = currentParticipantTalkTime + "% Participation in Conversation"
                role2Metric = codePercentageB + "% Code Written"

                fulfilledRoles = this.properlyFulfilledRoles(codePercentageB, currentParticipantTalkTime)
            }

            this.interventionSpecificMessages.push({
                role: "system",
                content: `${participants[0].name} has the ${role1} and therefore ${role1Goal}. ${participants[1].name} has the ${role2} role and therefore ${role2Goal}
                          Evaluate ${participants[0].name} and ${participants[1].name} on how well they are fulfilling their respective roles. If they are not fulfilling their roles properly, explain how they can do better to fulfill the specific roles that they have been assigned.
                          The students should NOT have a balanced workload.`,
              });

            //remove switching roles / hardcode
            this.interventionSpecificMessages.push({
                role: "system",
                content: `[METRIC] ${role1} ${participants[0].name}: ${role1Metric}
                          \n[METRIC] ${role2} ${participants[1].name}: ${role2Metric}`,
              });
            // await this.gpt();

            await this.gptLimitedContext();
            this.interventionSpecificMessages.pop();
            this.interventionSpecificMessages.pop();

            // if (numSwitches < 1 && fulfilledRoles) {
            if (fulfilledRoles)
                await this.sendTypingStatus(true)
                await sleep(1000)
                await this.sendTypingStatus(false)
                await this.send([
                    {type: "text", value: "Great work. You should now switch roles using the switch roles button at the top of your screen." } ])
            }
            // this.numRoleSwitches = databaseNumSwitches
    }

    async talkTimeIntervention(participants: ParticipantInfo[]){
        if (participants.length != 2) {
            console.warn("Did not find 2 students, skipping talk time intervention")
            return
        }
        var talkPercentages = await this.getTimeContribution()
      
        this.interventionSpecificMessages.push({
            role: "system",
            content:
              "If you determine one student is contributing relatively less, you should guide the students and provide specific, constructive feedback to share a more even workload. For instance, if the software provides you the following metrics: \n \
              [METRIC] Student A: 20% Conversation \n \
              [METRIC] Student B: 80% Conversation \n \
              \
              You should encourage Student A to participate more in the conversation. Note that the above metrics are only an example and should not be used. The Code in Place software will provide you similar tags. A conversation contribution between 40-60% is considered an even split between the students.",
          });
          this.interventionSpecificMessages.push({
            role: "system",
            content: participants.map(p => `[METRIC] ${p.name}: ${talkPercentages[p.name]}% Contribution to Conversation`).join("\n")
          });
          // await this.gpt();
          await this.gptLimitedContext();
          this.interventionSpecificMessages.pop();
          this.interventionSpecificMessages.pop();
    }

    async getTimeContribution(duration=600) {
        let timePerPerson: Record<string, number> = {}
        let totalContributions: Record<string, number> = {}
        let totalTime = 0

        const transcript = await this.fetchTranscript().catch(err => [])
        if (transcript.length === 0) {
            return timePerPerson
        }
        const last = transcript.at(-1)!
        transcript.forEach(segment => {
            if (segment.timestamp > last.timestamp - duration) {
                totalContributions[segment.name] = (totalContributions[segment.name] ?? 0) + segment.duration
                totalTime += segment.duration
            }
        })

        totalContributions = Object.fromEntries(Object.entries(timePerPerson).map(entry => [entry[0], Math.round(entry[1] / totalTime * 100)]))
        return totalContributions
    }

    async getCodeContribution(specificCode?: string): Promise<[number, number]> {
        if (specificCode != null) {
            var code = specificCode.replace(/[?\n]/g, "")
        }
        else {
            const codeHistory = await getCodeHistoryOfRoom(this.roomId)
            if (codeHistory.length > 0 && codeHistory[codeHistory.length - 1].author_map.length > 0) {
                var code = codeHistory[codeHistory.length - 1].author_map.replace(/[?\n]/g, "")
            }
            else {
                return [0,0]
            }
        }
        return [((code.match(/0/g) || "").length / code.length * 100), ((code.match(/1/g) || "").length / code.length * 100)]
    }
    // Runs every 5 minutes
    async periodicFunction(participants: ParticipantInfo[]) {
        if (this.condition <= 2) {
            const conditionName = ["Talk time", "Turn taking", "Intersubjectivity", "Control"][this.condition]
            await this.send([
                {
                    type: "text",
                    value: `(Debug message) Begin intervention for ${conditionName}`
                }
            ])
        }
        if (this.condition === 0) {
            await this.talkTimeIntervention(participants)
        } else if (this.condition === 1) { 
            await this.turnTakingIntervention(participants)             
        } else if (this.condition === 2) { 
            await this.intersubjectivityIntervention(participants)
        }
    }

    // Query GPT w/ limited context and display response in chat room
    async gptLimitedContext() {
        try {
            const completion = await this.openai.chat.completions.create({
                messages: this.interventionSpecificMessages,
                model: "gpt-3.5-turbo",
            });

            await this.sendTypingStatus(true);
            await sleep(1000);
            await this.sendTypingStatus(false);

            if (completion.choices[0].message.content != null ) {
                await this.send([{ type: "text", value: completion.choices[0].message.content }]);
            }
        }
        catch {

        }
        // Maybe Delete

        // this.brunoMessages.push({
        // role: "system",
        // content:
        //     "You have been provided metrics and were asked to evaluate the students. The following response is your analysis:",
        // });
        // this.brunoMessages.push(completion.choices[0].message);
    }


    //TO DO: Fix try/catch to account for rate limit issue (exponential backoff)
    // async gpt() {
    //     try {
    //         const completion = await this.openai.chat.completions.create({
    //             messages: this.brunoMessages,
    //             model: "gpt-3.5-turbo",
    //         });

    //         this.brunoMessages.push(completion.choices[0].message);

    //         await this.sendTypingStatus(true)
    //         await sleep(1000)
    //         await this.sendTypingStatus(false)
    //         await this.send([
    //             {type: "text", value: completion.choices[0].message.content || ""}
    //         ])
    //     }
    //     catch{

    //     }
    // }



    async composeAiGraderMessages() {

        if (this.roomId.length === 0) {
            console.warn("Selected roomId not found")
            return
        }

        const conn = await getConnection() 
        const [snapshot] = await makeQuery(conn, `SELECT code, question_id FROM Rooms WHERE id = ?`, [this.roomId])            
        if (snapshot.length === 0) {
            console.warn("Selected snapshot not found")
            await this.send([{ type: "text", value: "I don't see that you've written any code yet!" }]);
            conn.release()
            return
        } 

        let code = snapshot[0].code
        let questionId = snapshot[0].question_id 
        const [testCase] = await makeQuery(conn, "SELECT * from TestCases WHERE question_id = ?", [questionId])
        conn.release()

        console.log('composing chatgpt assessment for', testCase)

        await this.sendTypingStatus(true);

        if (testCase.length === 0) {
            console.warn("Selected test case not found")
        } else {

            const starterCode = testCase[0].starter_code
            const description = testCase[0].description

            let graderMessages: ChatCompletionMessageParam[] = [];
            graderMessages.push({
                "role": "system",
                "content": this.autograderSystemPrompt
            })
            graderMessages.push({
                "role": "system",
                "content": `Problem Description: ${description}`
            })
            graderMessages.push({
                "role": "system",
                "content": `Starter Code: ${starterCode}`
            })
            graderMessages.push({
                "role": "system",
                "content": `Student Code: ${code}`
            })

            try {

                const completion = await this.openai.chat.completions.create({
                messages: graderMessages,
                model: "gpt-3.5-turbo",
                });

                if (completion.choices[0].message.content != null ) {
                    const cleaned = completion.choices[0].message.content//.replace(/.+\{/sg, "{")
                    console.log('raw gpt message', cleaned)
                    const json = JSON.parse(cleaned)
                    if (json.score === 10) {
                        // await this.send([{ type: "text", value: json.feedback }]);
                        this.onQuestionPassed(questionId, testCase[0].title, [])
                    } else {
                        await this.send([{
                            type: "text",
                            value: json.feedback.length === 1 ? `Almost there! Here's the main issue with the code and how to fix it:\n- **${json.feedback[0].error.replace(/\.$/, "")}**: ${json.feedback[0].how_to_fix}` : `Good try! Here are the remaining issues with the code right now, and how to fix them:\n${json.feedback.map((f: any) => `- **${f.error.replace(/\.$/, "")}**: ${f.how_to_fix}`).join("\n")}`
                        }])
                    }
                }

            }
            catch (err) {
                console.warn(err)
                
                await this.send([{ type: "text", value: "I can't grade you right now due to an unexpected server issue. Please try again later." }])
            }
        }
        await this.sendTypingStatus(false);
    }

    //If someone refreshes before "take a moment to introduce yourself" is done
    async onParticipantsUpdated(participants: ParticipantInfo[]) {
        console.log(`Room ${this.roomId} received updated participant list`, participants.map(p => p.email))
        console.log("Current chat history length:", this.currentChatHistory.length)

        this.participantData = JSON.parse(JSON.stringify(participants));

        if (participants.length === 1 && this.currentChatHistory.filter(m => m.sender !== "system").length === 0) {
            // const currentParticipant = participants[0]
            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)

            await this.send([
                {type: "text", value: "We are still waiting for one more person to join the session."}
            ])
            await sleep(1000)
        }

        else if (participants.length === 2 && (participants[0].isOnline === true && participants[1].isOnline === true)) {
            if (this.state.stage === 0) {
                // Arbitrarily set participant 1 to role 1 and participant 2 to role 2
                let conn = await getConnection()
                await makeQuery(conn, "UPDATE Participants SET role = 1 WHERE room_id = ? AND user_email = ?", [this.roomId, participants[0].email])
                await makeQuery(conn, "UPDATE Participants SET role = 2 WHERE room_id = ? AND user_email = ?", [this.roomId, participants[1].email])
                if (participants[0].name == participants[1].name) {
                    await makeQuery(conn, "UPDATE Participants SET name = ? WHERE room_id = ? AND user_email = ?", [participants[1].name + "2", this.roomId, participants[1].email])
                }
                conn.release()

                this.participantNames[0] = participants[0].name
                this.participantNames[1] = participants[1].name

                // this.brunoMessages.push({
                //     role: "system",
                //     content: `Both students are in the session. Student A's name is ${participants[0].name}. Student B's name is ${participants[1].name}.`,

                // });

                //INTERVENTION SPECIFIC
                this.interventionSpecificMessages.push({
                    role: "system",
                    content: `Both students, ${participants[0].name} and ${participants[1].name}, are currently working on their selected problem. Do not greet them.`,
                });

                const conditionName = ["Talk time", "Turn taking", "Intersubjectivity", "Control"][this.condition]
                await this.send([
                    {
                        type: "text",
                        value: `(Debug message) Room condition: ${conditionName}`
                    }
                ])

                await this.sendTypingStatus(true)
                await sleep(1000)
                await this.sendTypingStatus(false)
                await this.send([
                    {type: "text", value: "Hi, I'm Bruno, your pair programming facillitator. I'm here to help you get the most out of this session."}
                ])
                await sleep(3000)
                
                await this.sendTypingStatus(true)
                await sleep(1000)
                await this.sendTypingStatus(false)
                await this.send([
                    {type: "text", value: "I've created a Zoom meeting for the two of you to communicate with each other as you work together. Please join the meeting now by clicking the “Join Video Call” button in the top left corner." } ])
                await sleep(3000)

                await this.sendTypingStatus(true)
                await sleep(1000)
                await this.sendTypingStatus(false)
                await this.send([
                    {type: "text", value: "When both of you are in the Zoom meeting, a PearProgram bot will be there to provide me information about your progress. It won't intervene your conversation in any way. You can safely ignore it." } ])
                await sleep(3000) 

                const readyMessageId = await this.send([
                    {type: "text", value: "Now, if you haven't already, take a moment to introduce yourself to your partner. Click the “Ready” button below to let me know once you are done."},
                    {type: "choices", value: ["Ready"]}
                ])

                // this.bothParticipantsJoined = true
                this.bothParticipantsOnline = true

                this.state.stage = 1
                await this.saveState()

                setTimeout(async () => {
                    // If 30 seconds passed, automatically move to stage 2
                    // reload chat history
                    const conn = await getConnection()
                    const [chatHistory] = await makeQuery(conn, "SELECT chat_history FROM Rooms WHERE id = ?", [this.roomId])
                    this.currentChatHistory = chatHistory[0].chat_history
                    if (this.state.stage === 1) {
                        this.onUserMakesChoice(readyMessageId, 0, 0, "")
                    }
                }, 30000)
            }
            else if (!this.bothParticipantsOnline && this.state.stage == 3) {  // If one participant was previously offline and now both are online, restart periodic function
                // this.periodicFunctionInstance = setInterval(()=>this.periodicFunction(participants), this.periodLength * 60 * 1000)
                this.bothParticipantsOnline = true
            }
        }

        // BRUNO DOES NOT KNOW WHEN A PARTICIPANT HAS LEFT. PERIODIC FUNCTIONS ARE RESET
        else if (participants.length === 2 && (!participants[0].isOnline || !participants[1].isOnline)) {  // If not every participant is online
            var studentName = ""
            if (participants[0].isOnline !== true) {
                studentName = participants[0].name
            }
            else if (participants[1].isOnline !== true) {
                studentName = participants[1].name
            }
            
            if (studentName !== ""){
                await sendEventOfType(this.roomId, "leave_session", "AI", { title: `${studentName} is currently offline. You can wait for ${studentName} to rejoin by closing this dialog, or navigate to pearprogram.co to start a new session.`, message: `Note: All coding progress will be lost if you join a new coding session! Save your code elsewhere (e.g. in notepad) if you would like to transfer your progress.` })

                // await this.send([
                //     {type: "text", value: "Note: All coding progress will be lost if you join a new coding session! Save your code elsewhere (e.g. in notepad) if you would like to transfer your progress."},
                //     {type: "choices", value: ["Join New Coding Session [Currently Non-Functional]"]}
                // ])
                
                // TODO: pause periodic function instead of clearing?
                this.bothParticipantsOnline = false
                // clearInterval(this.periodicFunctionInstance)
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


            await this.composeAiGraderMessages()

            // WHEN USER SENDS MESSAGE IN CHAT, SEND QUERY TO GPT AND OUTPUT RESPONSE
            // this.brunoMessages.push({
            //     role: "user",
            //     content: newChatHistory[newChatHistory.length - 1].content,
            // });
            // await this.gpt();
        }
    }

    async progressToStage2() {
        this.state.stage = 2
        await this.sendTypingStatus(true)
        await sleep(2000)
        await this.sendTypingStatus(false)
        await this.send([
            {type: "text", value: "The goal of pair programming is for both partners to understand every line of code. You should create a plan for how to program and work together to build it. \
                                \n\nResearch has shown that students who pair program have improved learning outcomes, gain confidence and enjoy programming more!" } ])
        await sleep(6000)

        await this.sendTypingStatus(true)
        await sleep(2000)
        await this.sendTypingStatus(false)
        await this.send([
            {type: "text", 
            value: `Heres how to pair program:

There are two roles in pair programming:
- **Driver**: This person writes the code. They should think out loud and help the navigator understand the code.
- **Navigator**: This person reviews each line of code as it is typed, considers the big picture, and provides directions and suggestions.

**Switch Roles Regularly**: To keep the session dynamic and engage both participants, switch roles frequently. This could be after a set amount of time (like every 10 minutes) or at the completion of a specific task.

**Communicate Effectively**: Open and continuous communication is crucial. Discuss what you are doing, why you are doing it, and what the expected outcome is. Ask questions and offer explanations freely.

**Respect and Patience**: Pair programming can be intense, and it's essential to be patient and respectful towards your partner.` } ])
        await sleep(5000)

        await this.send([
            {type: "text", value: `${this.participantNames[0]} has been assigned the "Driver" role. \n\n${this.participantNames[1]} has been assigned the "Navigator" role. You can switch these roles at any time using the 'Switch Roles' button at the top of your screen.`}
        ])

        await sendEventOfType(this.roomId, "update_role", "AI", { roles: {
            [this.participantData[0].email]: 1,
            [this.participantData[1].email]: 2
        } })

        let conn = await getConnection()
        const [questions] = await makeQuery(conn, "SELECT question_id, title FROM TestCases")
        await this.send([
            {type: "text", value: "Ok, let's pick a problem!"},
            {type: "choices", value: questions.map((q:any) => q.title)}
        ])
        // this.introductionFlag = true
        conn.release()

        await this.saveState()
    }

    async onUserMakesChoice(messageId: number, contentIndex: number, choiceIndex: number, email: string) {
        const section = this.currentChatHistory[messageId]?.content?.[contentIndex]
        if (section) {
            section.choice_index = choiceIndex
        } else {
            console.warn(`Cannot find ${messageId} ${contentIndex} ${choiceIndex}`)
            console.log(JSON.stringify(this.currentChatHistory))
            return
        }
        console.log(`User ${email} made choice: ${choiceIndex} for messageId ${messageId} contentIndex: ${contentIndex}`)

        if (this.state.stage === 1) {
            await this.progressToStage2()
        } else if (this.state.stage === 2 && (section?.value as string[])[0] !== "Ready") {
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
                    const otherUser = this.participantData.filter(p => p.email != email)[0]
                    await sendEventOfType(this.roomId, "question_update", "AI", { "email": email, "question": testCase[0]})
                    await this.send([
                        {
                            type: "text",
                            value: testCase[0].description
                        }
                    ])
                }
            }

            await this.sendTypingStatus(true)
            await sleep(1000)
            await this.sendTypingStatus(false)
            await this.send([{type: "text", value: "Press the Run Code button in the top right corner to execute your program." } ])

            this.periodicFunctionInstance = setInterval(()=>this.periodicFunction(this.participantData), this.periodLength * 60 * 1000)

            // this.brunoMessages.push({
            //     role: "system",
            //     content: "The students have selected the problem they want to work on and have begun coding. Do not greet them."
            // });

            //INTERVENTION SPECIFIC
            // this.interventionSpecificMessages.push({
            //     role: "system",
            //     content: "The students have selected the problem they want to work on and have begun coding. Do not greet them."
            // });
            // await this.gpt()

            // this.periodicFunctionStarted = true

            this.state.stage = 3
            await this.saveState()
            conn.release()

        }    
    }

    async onQuestionPassed(questionId: string, questionTitle: string, testResults: any[]) {
        console.log('passed', questionId, questionTitle, testResults)
        if (!this.state.solvedQuestionIds.includes(questionId)) {
            this.state.solvedQuestionIds.push(questionId)
        
            await this.send([{
                type: "text",
                value: `Congrats for solving ${questionTitle}! I hope that you enjoyed this coding session.`
            }])
            await this.saveState()
            await sleep(3000)
            await this.send([{
                type: "text",
                value: "Please take a few minutes to share your feedback regarding your coding experience at [this link](https://forms.gle/3a7kP3YgC8zjZuaQ8)."
            }])
            await sleep(3000)
            await this.send([{
                type: "text",
                value: "If you are interested in working on more problems, you can select a different problem by clicking the **Switch Coding Problem** button."
            }])
        } else {
            await this.send([{
                type: "text",
                value: `Congrats again for solving ${questionTitle}!`
            }])
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

    // Failable. Need to be catched.
    async fetchTranscript() {
        if (!this.recallBotId) { return [] } // If bot not yet entered, there's no transcript to return

        const rawTranscript = (await recallInstance.get(`/bot/${this.recallBotId}/transcript`)).data as Record<string, any>[]

        return rawTranscript.map(entry => {
            if (entry.speaker.endsWith(" 1")) {
                entry.speaker = entry.speaker.slice(0, -2)
            }
            return {
                timestamp: entry.end_timestamp as number,
                duration: entry.end_timestamp - entry.start_timestamp as number,
                speech: entry.text as string,
                name: entry.speaker as string
            }
        })
    }

    async onBotEnteredZoom(botId: string) {
        this.recallBotId = botId
        await sendNotificationToRoom(this.roomId, "PearProgram Bot has joined the Zoom meeting.")
    }

    async onBotLeftZoom(botId: string) {
        this.recallBotId = undefined
        await sendNotificationToRoom(this.roomId, "PearProgram Bot has left the Zoom meeting.")
    }

    async onZoomParticipantUpdated() {
        if (ACTIVE_PARTICIPANTS.size === 1 && this.previousZoomParticipantCount === 2) {
            this.onePersonExitReminder = setTimeout(() => {
                this.send([
                    {
                        type: "text",
                        value: "Looks like someone exited the Zoom meeting. If this is unintentional, please use the **Join Video Call** button in PearProgram to rejoin."
                    }
                ])
            }, 10000)
        } else if (ACTIVE_PARTICIPANTS.size >= 2) {
            clearTimeout(this.onePersonExitReminder)
        } else if (ACTIVE_PARTICIPANTS.size === 0 && this.previousZoomParticipantCount === 2) {
            clearTimeout(this.onePersonExitReminder)
            this.send([
                {
                    type: "text",
                    value: "Looks like no one is in the Zoom meeting anymore. I will be closing in 1 minute. I hope you enjoyed your call together. You can always come back to your code by visiting the same URL."
                }
            ])
        }
        this.previousZoomParticipantCount = ACTIVE_PARTICIPANTS.size
    }
}

async function sleep(ms: number) {
    await new Promise((r, _) => setTimeout(r, ms))
}
