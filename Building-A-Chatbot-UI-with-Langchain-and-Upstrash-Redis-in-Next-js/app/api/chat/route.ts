// 1. Import required modules
import { Redis } from "@upstash/redis";
import { UpstashRedisChatMessageHistory } from "langchain/stores/message/upstash_redis";
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { AgentExecutor} from "langchain/agents";
import { BufferMemory, ConversationSummaryBufferMemory} from "langchain/memory";
import { ConversationChain } from "langchain/chains";
import { StreamingTextResponse, LangChainStream} from 'ai';
import { Calculator } from "langchain/tools/calculator";
import { loadAgent } from "langchain/agents/load";
import { initializeAgentExecutorWithOptions } from "langchain/agents";
import { DynamicTool, DynamicStructuredTool} from "langchain/tools";
import * as z from 'zod';
import { MessagesPlaceholder } from "langchain/dist/prompts";

interface ListLawToolRequest{
  [key: string]: any;
}

interface LawElement{
  [key: string]: string;

}

//const url = 'https://api.lawapi-prototype-test-elaws.e-gov.go.jp/api/2'

const get_function = async(keyword: string) => {

    const url = 'https://api.lawapi-prototype-test-elaws.e-gov.go.jp/api/2/keyword'
    const params: ListLawToolRequest = {}
    params["keyword"] = keyword
    params["limit"] = 2
    const query_params = new URLSearchParams(params); 
    console.log(query_params)
    
    return await fetch(`${url}?${query_params}`, {
        method: "GET",
    })
    .then(response => response.json())
    .then(data => {
        const res_list = []
        const items = data["items"]
        items.forEach((item) => {
            const reduced_item: LawElement = {}
            reduced_item["law_id"] = item["law_info"]["law_id"]
            reduced_item["law_num"] = item["law_info"]["law_num"]
            reduced_item["sentence"] = item["sentence"]
            res_list.push(reduced_item)

        })
        console.log("\nhere===========")
        console.log(res_list)
        return res_list

    })
}

const listLawTool = new DynamicTool({
      name: "ListLawTool",
      description:
        `Get laws which is related to the keyword.
        If you know the keyword to search the law, please call this.
        `,
      // schema: z.object({
      //   law_id: z.string(),
      //   law_num: z.string(),
      //   sentence: z.string(),
      // }),
      func: async (query) => {
        const params: ListLawToolRequest = {}
        const res = await get_function(query)
        console.log("\nhrere======================")
        console.log(res)
        // const tmp = {}
        // tmp["law_id"] = "test_id"
        // tmp["law_num"] = "test_num"
        // tmp["sentence"] = "test_sentence"
        return res.toString()
      },
    });

// 2. Initialize Redis client
const client = Redis.fromEnv()
// 3. Set runtime environment
export const runtime = 'edge';



// 4. Define POST function
export async function POST(req: Request) {
  // 5. Initialize stream and handlers
  const { stream, handlers } = LangChainStream();
  // 6. Parse request JSON
  const { messages, userId, loadMessages } = await req.json();
  // 7. Load chat history if requested
  if (userId && loadMessages) {
    const populateHistoricChat = (await client.lrange(userId, 0, -1)).reverse();
    return new Response(JSON.stringify(populateHistoricChat));
  }
  // 8. Initialize memory buffer and chat history
  const memory = new BufferMemory({
    chatHistory: new UpstashRedisChatMessageHistory({
      sessionId: userId,
      client: Redis.fromEnv(),
    }),
  });

  // 9. Initialize chat model
  const llm = new ChatOpenAI({
    modelName: "gpt-3.5-turbo-0613",
    // modelName: "gpt-4",
    temperature: 0,
    streaming: true,
  });
  // 10. Initialize conversation chain


  
  // ツールの準備
  const tools = [listLawTool];

  // エージェントの準備
  // const agent = await loadAgent(
  //   "lc://agents/zero-shot-react-description/agent.json",
  //   { llm: llm, tools }
  // );
  // const executor = AgentExecutor.fromAgentAndTools({
  //   agent,
  //   tools,
  //   returnIntermediateSteps: true,
  // });
  const prompt = `
    あなたは法律の専門家です。
    法律について検索をすることができますが、検索するにはキーワードが必要です。
    もしキーワードがわからない場合は、予測や推測をせずに、「どんな内容の法律についてお調べですか？」と回答してください。
    キーワードがわかった場合は、ListLawToolを使って関連する法律を検索してください。
    取得した法律の中から、ユーザが探していると考えられる順に法律を並べて提示してください。
    法令番号、法令ID、法令の簡潔な内容、e-gov のウェブサイトへのリンクも提示してください。
    提示した後は、「詳細について知りたいときは法令番号をお申し付けください」と回答してください。
  `;
  //キーワードが曖昧な場合は、「検索できるキーワードを書いてください」と回答してください。

  const executor = await initializeAgentExecutorWithOptions(tools, llm, {
    agentType: "openai-functions",
    verbose: true,
    returnIntermediateSteps: false,
    // memory: memory,
    agentArgs: {
      prefix: prompt,
    },
  });



  //const chain = new ConversationChain({ llm: llm, memory });
  // 11. Get the last message from the input messages
  const lastMessage = messages[messages.length - 1].content;

  // ===============================================================
  // ===============================================================
  // option 1, executor.run
  // const result = await executor.run({
  //   input: lastMessage, callbacks: [handlers]
  // });
  const result = await executor.run(lastMessage);
  // const result = await executor.call({
  //   input: lastMessage, callbacks: [handlers],
  // })

  const chunks = result.split(" ");

  const responseStream = new ReadableStream({
    async start(controller){
      for (const chunk of chunks){
        const bytes = new TextEncoder().encode(chunk + " ");
        controller.enqueue(bytes);
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 + 10)))

      }
      controller.close()
    },
  });

  return new StreamingTextResponse(responseStream);


  // ===============================================================
  // ===============================================================
  // option 2, executor.call

  // // 12. Call the conversation chain with the last message and handlers
  // executor.call({
  //   input: lastMessage, callbacks: [handlers]
  // })

  // // 13. Return a streaming text response
  // return new StreamingTextResponse(stream);
}