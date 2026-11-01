'use client';

import { useRef, useState } from 'react';
import { button, field } from './ComicShell';

function agentPrompt(endpoint: string) {
  return `Connect Comex to this agent so we can create comics together.

Add a remote MCP server named "comex" using Streamable HTTP at ${endpoint}. Use your native MCP setup and OAuth login. Request these scopes: comex:read comex:write comex:generate comex:publish offline_access. Open the sign-in link in my browser so I can connect my Comex workspace.

If you cannot add MCP servers yourself, give me the shortest setup steps for this client using that URL. Once connected, discover the available tools and ask me what comic I want to create. Guide me through the story, characters and artwork, then show me the result. Publish only when I ask.`;
}

export default function ConnectAgent({ mcpUrl }: { mcpUrl?: string }) {
  const [copied, setCopied] = useState(false);
  const [manualPrompt, setManualPrompt] = useState('');
  const fallback = useRef<HTMLTextAreaElement>(null);

  async function copyPrompt() {
    const prompt = agentPrompt(mcpUrl ?? new URL('/mcp', window.location.origin).href);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(prompt);
      setManualPrompt('');
      setCopied(true);
    } catch {
      setManualPrompt(prompt);
    }
  }

  return <section id="connect-agent" aria-labelledby="connect-agent-title" className="mt-7 border-[3px] border-[#171717] bg-[#fffef8] p-6 shadow-[5px_5px_0_#171717] sm:px-8">
    <div className="flex flex-wrap items-center justify-between gap-5">
      <div>
        <h2 id="connect-agent-title" className="font-display text-3xl uppercase tracking-[0.02em]">Connect your agent</h2>
        <p className="mt-2">Copy the prompt, paste it into your agent, and make a comic together.</p>
      </div>
      <button type="button" className={`${button} shrink-0`} onClick={copyPrompt}>{copied ? 'Copied!' : 'Copy prompt'}</button>
    </div>
    <span role="status" className="sr-only">{copied ? 'Prompt copied. Paste it into your agent.' : ''}</span>
    {manualPrompt && <div className="mt-5">
      <label htmlFor="agent-prompt" className="block text-sm font-bold">Copy this prompt and paste it into your agent:</label>
      <textarea id="agent-prompt" ref={fallback} readOnly value={manualPrompt} rows={7} className={`${field} mt-2`} onFocus={event => event.currentTarget.select()} />
      <button type="button" className="mt-2 font-bold underline" onClick={() => { fallback.current?.focus(); fallback.current?.select(); }}>Select prompt</button>
    </div>}
  </section>;
}
