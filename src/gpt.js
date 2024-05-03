import OpenAI from "openai";

const openai = new OpenAI({
  apiKey:
    process.env["sk-proj-yeUooWJipEcgQNTxD0H3T3BlbkFJBSu5GNeiv8rSZ3n67XoN"], // This is the default and can be omitted
});

var prompt =
  "You are Bruno. You are a mentor for the Code in Place project, which is a free intro-to-coding course from Stanford University that is taught online. The Code in Place project recruits and trains one volunteer teacher for every students in order to maintain a proportional ratio of students to teachers. \n \
\
Code in Place is now piloting a Pair Programming feature, where two students are paired up to work together on an assignment. As a mentor, your role is to guide these students through the pair programming process and help them work together. Your job also involves assessing the students' individual contributions to the assignment in terms of code written and involvement in conversations or brainstorming. You perform this assessment by looking at metrics provided to you by the shared coding environment the students are using. Wait to assess the students until you have been provided metrics from this software--the metrics will be tagged [METRIC]. \n \
\
If you determine one student is contributing relatively less, you should guide the students and provide specific, constructive feedback to share a more even workload. For instance, if the software provides you the following metrics: \n \
[METRIC] Student A: 20% Code \n \
[METRIC] Student B: 80% Code \n \
\
You should encourage Student A to participate more in writing the code. Note that the above metrics are only an example and should not be used. The Code in Place software will provide you similar tags. Only assess the students once you have received these tagged messages. \n \
\
There are currently 0 students in the coding environment. You will be notified once one (or both) students have joined. \n \
\
Do not number or label your messages. Do not break character or mention that you are an AI Language Model.";

// Potentially switch to threads https://platform.openai.com/docs/assistants/overview
var chatMessages = [{ role: "system", content: prompt }];

var userA = "";
var userB = "";
/*
 + To Do:
 + Convert JS TO TYPESCRIPT
 + Connect to actual user input
 + Add metric data to function
 +    Percentage of Conversations + Overall Code Written
 +    Intersubjectivity -- Pick random 10-15 line chunk creatd by one person (or majority/threshold)
 + Send GPT output back as a message
*/
const ParticipantInfo = {
  participantName: null,
  id: null,
  email: null,
  isOnline: null,
};

var participant1 = [
  { participantName: "John", id: null, email: null, isOnline: null },
  { participantName: null, id: null, email: null, isOnline: null },
];
var participant2 = [
  { participantName: "John", id: null, email: null, isOnline: null },
  { participantName: "Adam", id: null, email: null, isOnline: null },
];

// Evaluate Role Switches Between Navigator/Driver
// Queries GPT w/ context then removes extraneous messages

// GPT IS NOT DOING WELL W ROLE SWITCH, HARD CODE BASED ON PERCENTAGES ??
async function evaluateRoleSwitch(data) {
  var tempChatMessages = [chatMessages[chatMessages.length - 1]];
  tempChatMessages.push({
    role: "system",
    content:
      'Did the previous message recommend switching roles? Respond with one word word, "Yes" or "No", precisely as they are written.',
  });
  const completion = await openai.chat.completions.create({
    messages: tempChatMessages,
    model: "gpt-3.5-turbo",
  });
  tempChatMessages.push(completion.choices[0].message);

  console.log("SANITY CHECK SANITY CHECK SANITY CHECK");
  console.log("SANITY CHECK SANITY CHECK SANITY CHECK");
  console.log("SANITY CHECK SANITY CHECK SANITY CHECK");

  console.log(tempChatMessages);
}

async function turnTakingIntervention(data, currentRoles) {
  //Move to onParticipantsUpdated?
  //Store in ParticipantInfo?
  if (currentRoles == null) {
    participant1.role = "driver";
    participant2.role = "navigator";
  }

  var aCodePercentage = 80;
  var bCodePercentage = 20;
  var aTalkPercentage = 35;
  var bTalkPercentage = 65;

  chatMessages.push({
    role: "system",
    content:
      "John" +
      " currently has the " +
      "[DRIVER]" +
      " role, while " +
      "Adam" +
      " has the " +
      "[NAVIGATOR]" +
      " role. \
  Because John has the [DRIVER] role, John should be writing the majority of the code and contributing less to the conversations. Because Adam has the [NAVIGATOR] role, Adam should verbally contribute to the majority of the conversation and contribute less to writing the code. \
  Evaluate John and Adam based on how well they are fulfilling their respective roles. If they are not fulfilling their roles properly, explain how they can do better to fulfill the specific roles that they have been assigned. If they have properly fulfilled their roles, \
  praise the students.",
  });
  chatMessages.push({
    role: "system",
    content:
      "[METRIC] " +
      "John" +
      ": " +
      aCodePercentage +
      "% Code \n \
      [METRIC] " +
      "Adam" +
      ": " +
      bCodePercentage +
      "% Code \n\n" +
      "[METRIC]" +
      "John" +
      ": " +
      aTalkPercentage +
      "% Contribution to Conversation \n \
      [METRIC] " +
      "Adam" +
      ": " +
      bTalkPercentage +
      "% Contribution to Conversation",
  });
  await main();
  await evaluateRoleSwitch();
}

async function talkTimeIntervention(data) {
  var aTalkPercentage = 20;
  var bTalkPercentage = 80;

  chatMessages.push({
    role: "system",
    content:
      "The students should switch roles IF AND ONLY IF they have properly fulfilled their currently assigned roles. \n[METRIC]" +
      participant1.participantName +
      ": " +
      aTalkPercentage +
      "% Contribution to Conversation \n \
      [METRIC] " +
      participant2.participantName +
      ": " +
      bTalkPercentage +
      "% Contribution to Conversation",
  });
  await main();
}

// Need to handle case where 1/both participants leave
// Assuming participants array always length 2 (even if only 1 participant)
async function onParticipantsUpdated(participants) {
  if (
    participants[0].participantName != null &&
    participants[1].participantName != null
  ) {
    chatMessages.push({
      role: "system",
      content:
        "Both students have joined the session. Student A's name is " +
        participants[0].participantName +
        ", Student B's name is " +
        participants[1].participantName,
    });
  } else {
    chatMessages.push({
      role: "system",
      content:
        "Student A has joined the session. Refer to them as " +
        participants[0].participantName,
    });
  }
  // console.log(
  //   `Room ${this.roomId} received updated participant list`,
  //   participants
  // );
  await main();
}

async function main() {
  // chatMessages.push({ role: "system", content: "One student has joined." });
  // chatMessages.push({
  //   role: "user",
  //   content: "Hello. What is pair programming?",
  // });

  const completion = await openai.chat.completions.create({
    messages: chatMessages,
    model: "gpt-3.5-turbo",
  });

  chatMessages.push(completion.choices[0].message);
  console.log(chatMessages);
}

// main();
await onParticipantsUpdated(participant1);
await onParticipantsUpdated(participant2);

//can use clearInterval(intervalID) in onParticipantsUpdated() to reset if num participants changes
// var intervalID = setInterval(() => talkTimeIntervention(), 10000);
var intervalID = setInterval(() => turnTakingIntervention(), 10000);
