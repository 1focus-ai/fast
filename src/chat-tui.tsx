import * as React from "react"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
  createRoot,
} from "@opentui/react"
import { createCliRenderer } from "@opentui/core"

export interface ChatUIOptions {
  apiKey: string
  model: string
  systemPrompt?: string
}

type AssistantStatus = "idle" | "loading" | "error"

interface ChatMessage {
  id: number
  role: "user" | "assistant"
  content: string
  status?: AssistantStatus
}

const BASE_BACKGROUND = "#000000"
const INPUT_BACKGROUND = "#111111"
const USER_COLOR = "#85e89d"
const ASSISTANT_COLOR = "#f2f4f8"
const ERROR_COLOR = "#ff6b6b"
const HINT_COLOR = "#868e96"
const CURSOR_BG = "#ffd43b"
const CURSOR_FG = "#000000"
const DEFAULT_SYSTEM_PROMPT =
  "You are a friendly CLI copilot. Answer succinctly, prefer actionable steps, and format using Markdown when helpful."

export async function startChatInterface(options: ChatUIOptions) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  })

  createRoot(renderer).render(<ChatApp {...options} />)
}

function ChatApp({ apiKey, model, systemPrompt }: ChatUIOptions) {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const [messages, setMessages] = React.useState<ChatMessage[]>([
    {
      id: 0,
      role: "assistant",
      content: "Ask me anything about your work. Press Enter to send, ESC to exit.",
    },
  ])
  const [input, setInput] = React.useState("")
  const [isSending, setIsSending] = React.useState(false)
  const [statusLine, setStatusLine] = React.useState("Ready")
  const nextIdRef = React.useRef(1)
  const messagesRef = React.useRef(messages)
  const inputRef = React.useRef(input)

  messagesRef.current = messages
  inputRef.current = input

  React.useEffect(() => {
    renderer.console.hide()
    return () => {
      renderer.console.show()
    }
  }, [renderer])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      process.exit(0)
    }

    if (key.name === "escape") {
      process.exit(0)
    }

    if (key.name === "return") {
      if (key.shift) {
        setInput((prev) => prev + "\n")
      } else {
        if (!isSending) {
          void submitPrompt()
        }
      }
      return
    }

    if (key.name === "backspace") {
      if (inputRef.current.length > 0) {
        setInput((prev) => prev.slice(0, -1))
      }
      return
    }

    if (key.sequence === "\t") {
      setInput((prev) => prev + "  ")
      return
    }

    if (
      key.sequence &&
      key.sequence.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      !key.option
    ) {
      setInput((prev) => prev + key.sequence)
    }
  })

  async function submitPrompt() {
    const prompt = inputRef.current.trim()
    if (!prompt) {
      setStatusLine("Type a message to send")
      return
    }

    if (isSending) {
      return
    }

    setInput("")
    setStatusLine("Sending...")
    setIsSending(true)

    const userMessage = createMessage("user", prompt)
    const assistantMessage = createMessage("assistant", "")

    setMessages((prev) => [...prev, userMessage, { ...assistantMessage, status: "loading" }])

    try {
      const reply = await requestCompletion({
        apiKey,
        model,
        systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        history: messagesRef.current
          .filter((message) => message.content.trim().length > 0)
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
        prompt,
      })

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: reply,
                status: "idle",
              }
            : message
        )
      )
      setStatusLine("Response received")
    } catch (error) {
      const fallback =
        error instanceof Error
          ? error.message
          : "Failed to fetch response from the model"
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: fallback,
                status: "error",
              }
            : message
        )
      )
      setStatusLine("Request failed")
    } finally {
      setIsSending(false)
    }
  }

  function createMessage(role: "user" | "assistant", content: string): ChatMessage {
    const message: ChatMessage = {
      id: nextIdRef.current++,
      role,
      content,
    }
    return message
  }

  function renderInput() {
    const nodes: React.ReactNode[] = []
    if (input.length === 0) {
      nodes.push(
        <span key="placeholder" style={{ fg: HINT_COLOR }}>
          Type your request…
        </span>
      )
    } else {
      for (let i = 0; i < input.length; i++) {
        nodes.push(
          <span key={i} style={{ fg: ASSISTANT_COLOR, bg: "transparent" }}>
            {input[i]}
          </span>
        )
      }
    }

    nodes.push(
      <span key="cursor" style={{ fg: CURSOR_FG, bg: CURSOR_BG }}>
        {" "}
      </span>
    )
    return nodes
  }

  return (
    <box
      style={{
        flexDirection: "column",
        height: "100%",
        width: "100%",
        padding: 1,
        gap: 1,
        backgroundColor: BASE_BACKGROUND,
      }}
    >
      <box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          overflow: "hidden",
          width: Math.max(40, width - 4),
        }}
      >
        {messages.map((message) => (
          <MessageBlock key={message.id} message={message} />
        ))}
        {isSending ? (
          <text style={{ fg: HINT_COLOR }}>Thinking…</text>
        ) : null}
      </box>

      <box
        style={{
          flexDirection: "column",
          width: Math.max(40, width - 4),
          backgroundColor: INPUT_BACKGROUND,
          padding: 1,
        }}
      >
        <text style={{ fg: HINT_COLOR, marginBottom: 1 }}>
          Enter to send · Shift+Enter for newline · ESC to exit
        </text>
        <text style={{ flexWrap: "wrap" }}>{renderInput()}</text>
      </box>

      <box style={{ flexDirection: "row", width: Math.max(40, width - 4) }}>
        <text style={{ fg: HINT_COLOR }}>{statusLine}</text>
      </box>
    </box>
  )
}

function MessageBlock({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant"
  const color =
    message.status === "error"
      ? ERROR_COLOR
      : isAssistant
        ? ASSISTANT_COLOR
        : USER_COLOR

  const label = isAssistant ? "assistant" : "you"
  const labelColor = isAssistant ? "#ffd43b" : "#2f9e44"

  return (
    <box
      style={{
        flexDirection: "column",
        paddingBottom: 1,
        width: "100%",
      }}
    >
      <text style={{ fg: labelColor }}>{label}</text>
      <text style={{ fg: color, flexWrap: "wrap" }}>
        {message.content || (message.status === "loading" ? "…" : "")}
      </text>
    </box>
  )
}

interface CompletionRequest {
  apiKey: string
  model: string
  systemPrompt: string
  history: { role: "user" | "assistant"; content: string }[]
  prompt: string
}

async function requestCompletion({
  apiKey,
  model,
  systemPrompt,
  history,
  prompt,
}: CompletionRequest) {
  const payload = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user", content: prompt },
    ],
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`Model error: ${response.status} ${details}`)
  }

  const data: unknown = await response.json()
  const content =
    typeof data === "object" && data != null && "choices" in data
      ? (data as any).choices?.[0]?.message?.content
      : undefined

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Model returned an empty response")
  }

  return content.trim()
}
