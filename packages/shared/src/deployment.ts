// The accounts this deployment lives in. Identifiers, not credentials: a fork changes these three
// and sets its own secrets. The console reads them; the agent push script updates this agent and
// tool.

/** Cloudflare account that runs the Workers, the Workflow and the R2 buckets. */
export const CLOUDFLARE_ACCOUNT_ID = "6c8959f08233cb34a0bbfa8e664f6648";

/** The ElevenLabs agent callers talk to. */
export const ELEVENLABS_AGENT_ID = "agent_4201m39wmxxvf76snhp94gwajr7c";

/** Its `find_doctor` webhook tool. */
export const ELEVENLABS_TOOL_ID = "tool_3201m39xzp15ermvkhn3vq3cpqce";
