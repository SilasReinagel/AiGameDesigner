require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require("openai");
const marked = require('marked');
const open = require('open');

// Verify required environment variables
const requiredEnvVars = ['OPENAI_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Serve static files with correct MIME types
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.js')) {
      res.set('Content-Type', 'application/javascript');
    }
  }
}));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const roles = {
  designerA: "Game Designer A",
  designerB: "Game Designer B",
  gamerC: "Gamer C",
  criticD: "Game Critic D",
  gddWriterE: "Game GDD Writer E",
  managerF: "Project Manager F",
  artistG: "Concept Artist G",
  qaAgent: "QA Agent"
};

let totalInputTokens = 0;
let totalOutputTokens = 0;

async function createChatCompletion(messages) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: messages,
  });
  totalInputTokens += response.usage.prompt_tokens;
  totalOutputTokens += response.usage.completion_tokens;
  return response.choices[0].message.content;
}

async function generateImage(prompt) {
  const response = await openai.images.generate({
    prompt: prompt,
    n: 1,
    size: "512x512",
  });
  // Note: Image generation doesn't provide token usage, so we'll estimate
  totalInputTokens += prompt.split(' ').length; // Rough estimate
  return response.data[0].url;
}

async function writeToFile(folderPath, fileName, content) {
  await fs.writeFile(path.join(folderPath, fileName), content);
}

async function performQA(step, output, originalInput) {
  console.log(`QA Phase for ${step} - Start`);
  const qaPrompt = `
    As a QA Agent, review the output of the "${step}" step:
    
    Original Input: ${originalInput}
    Step Output: ${output}

    Ensure that the output aligns with the original input and meets the following criteria:
    1. Relevance to the original game idea
    2. Completeness of the step's objectives
    3. Consistency with previous steps (if applicable)
    4. Clarity and coherence of the content

    If any issues are found, provide specific feedback. If no issues are found, confirm that the step output is satisfactory.
  `;

  const qaResult = await createChatCompletion([
    { role: "system", content: "You are a meticulous QA agent for game design documents." },
    { role: "user", content: qaPrompt }
  ]);

  console.log(`QA Phase for ${step} - End`);
  return qaResult;
}

app.post('/generate-gdd', async (req, res) => {
  const { baseIdea } = req.body;
  const folderName = `${uuidv4()}-${baseIdea.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
  const folderPath = path.join(__dirname, '..', 'output', folderName);
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendUpdate = (type, data) => {
    res.write(`${JSON.stringify({ type, ...data })}\n`);
  };

  console.log('Starting GDD generation process...');

  await fs.mkdir(folderPath, { recursive: true });
  
  console.log('Step 1: Base Idea - Start');
  sendUpdate('progress', { step: 'base-idea', output: baseIdea });
  await writeToFile(folderPath, '1_base_idea.txt', baseIdea);
  const baseIdeaQA = await performQA('Base Idea', baseIdea, baseIdea);
  sendUpdate('progress', { step: 'base-idea-qa', output: baseIdeaQA });
  await writeToFile(folderPath, '1_base_idea_qa.txt', baseIdeaQA);
  console.log('Step 1: Base Idea - End');
  
  console.log('Step 2: Discussion - Start');
  sendUpdate('progress', { step: 'discussion', output: 'Starting discussion...' });
  let gameIdea = baseIdea;
  for (let i = 0; i < 5; i++) {
    console.log(`Discussion Round ${i + 1} - Start`);
    const discussion = await createChatCompletion([
      { role: "system", content: "You are a group of game design professionals discussing a game idea." },
      { role: "user", content: `Discuss and iterate on this game idea: ${gameIdea}` },
      { role: "assistant", content: `${roles.designerA}: Let's consider...` },
      { role: "assistant", content: `${roles.designerB}: I think we should...` },
      { role: "assistant", content: `${roles.gamerC}: From a player's perspective...` },
      { role: "assistant", content: `${roles.criticD}: Critically speaking...` },
    ]);
    sendUpdate('progress', { step: 'discussion', output: `Round ${i + 1}: ${discussion}` });
    await writeToFile(folderPath, `2_discussion_${i + 1}.txt`, discussion);
    gameIdea = discussion.split('\n').pop();
    console.log(`Discussion Round ${i + 1} - End`);
  }
  const discussionQA = await performQA('Discussion', gameIdea, baseIdea);
  sendUpdate('progress', { step: 'discussion-qa', output: discussionQA });
  await writeToFile(folderPath, '2_discussion_qa.txt', discussionQA);
  console.log('Step 2: Discussion - End');
  
  console.log('Step 3: GDD Writing - Start');
  sendUpdate('progress', { step: 'gdd-writing', output: 'Starting GDD writing...' });
  let gdd = "";
  for (let i = 0; i < 5; i++) {
    console.log(`GDD Writing Iteration ${i + 1} - Start`);
    gdd = await createChatCompletion([
      { role: "system", content: "You are a team working on a Game Design Document (GDD)." },
      { role: "user", content: `Write or improve the GDD for this game idea: ${gameIdea}` },
      { role: "assistant", content: `${roles.gddWriterE}: Let's structure the GDD as follows...` },
      { role: "assistant", content: `${roles.designerA}: We should include...` },
      { role: "assistant", content: `${roles.designerB}: Don't forget to mention...` },
      { role: "assistant", content: `${roles.managerF}: From a project management perspective...` },
    ]);
    sendUpdate('progress', { step: 'gdd-writing', output: `Iteration ${i + 1}: ${gdd.substring(0, 200)}...` });
    await writeToFile(folderPath, `3_gdd_iteration_${i + 1}.md`, gdd);
    console.log(`GDD Writing Iteration ${i + 1} - End`);
  }
  const gddQA = await performQA('GDD Writing', gdd, baseIdea);
  sendUpdate('progress', { step: 'gdd-writing-qa', output: gddQA });
  await writeToFile(folderPath, '3_gdd_qa.txt', gddQA);
  console.log('Step 3: GDD Writing - End');
  
  console.log('Step 4: Concept Art - Start');
  sendUpdate('progress', { step: 'concept-art', output: 'Generating concept art...' });
  const artPrompt = await createChatCompletion([
    { role: "system", content: "You are a concept artist creating a prompt for an AI image generator." },
    { role: "user", content: `Create an image prompt for this game: ${gameIdea}` },
    { role: "assistant", content: `${roles.artistG}: Here's a prompt for the game's key visual...` },
  ]);
  const artUrl = await generateImage(artPrompt);
  sendUpdate('progress', { step: 'concept-art', output: `Art prompt: ${artPrompt}\nArt URL: ${artUrl}` });
  await writeToFile(folderPath, '4_concept_art_prompt.txt', artPrompt);
  await writeToFile(folderPath, '4_concept_art_url.txt', artUrl);
  const artQA = await performQA('Concept Art', artPrompt, baseIdea);
  sendUpdate('progress', { step: 'concept-art-qa', output: artQA });
  await writeToFile(folderPath, '4_concept_art_qa.txt', artQA);
  console.log('Step 4: Concept Art - End');
  
  console.log('Step 5: Finalizing GDD - Start');
  sendUpdate('progress', { step: 'final-gdd', output: 'Finalizing GDD...' });
  const finalGdd = `# Game Design Document\n\n${gdd}\n\n## Concept Art\n\n![Concept Art](${artUrl})`;
  await writeToFile(folderPath, '5_final_gdd.md', finalGdd);
  
  const htmlGdd = marked.parse(finalGdd);
  await writeToFile(folderPath, '5_final_gdd.html', htmlGdd);
  
  const finalGddQA = await performQA('Final GDD', finalGdd, baseIdea);
  sendUpdate('progress', { step: 'final-gdd-qa', output: finalGddQA });
  await writeToFile(folderPath, '5_final_gdd_qa.txt', finalGddQA);
  console.log('Step 5: Finalizing GDD - End');

  const tokenUsage = `Total Input Tokens: ${totalInputTokens}\nTotal Output Tokens: ${totalOutputTokens}`;
  console.log('Token Usage:');
  console.log(tokenUsage);

  await writeToFile(folderPath, 'token_usage.txt', tokenUsage);

  sendUpdate('result', { folderPath, finalGdd: htmlGdd, tokenUsage, qaResults: {
    baseIdeaQA, discussionQA, gddQA, artQA, finalGddQA
  }});
  console.log('GDD generation process completed.');
  res.end();

  // Reset token counters for the next request
  totalInputTokens = 0;
  totalOutputTokens = 0;
});

const PORT = process.env.PORT || 8855;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  openBrowser();
});

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  open(url).catch(() => {
    console.log(`Unable to open browser automatically. Please visit ${url} manually.`);
  });
}