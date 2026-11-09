"""LLM providers (Lesson 1/4/5).

The LLM is "the primary source of overall pipeline latency", so every provider here is a
*streaming* provider and the session measures Time-To-First-Token (TTFT) and tokens/second.

Groq, Cerebras, TogetherAI, OpenAI and Ollama all speak the OpenAI chat-completions dialect, so
one class covers them – swapping the "fast inference provider" is just a base URL + key
(the Lesson 1 optimisation: "API routing: use ultra-fast inference providers").
"""
from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from ..config import settings


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class LLMEvent:
    kind: str  # "text" | "tool_call" | "usage"
    text: str = ""
    tool: ToolCall | None = None
    usage: dict[str, int] = field(default_factory=dict)


class LLMProvider(Protocol):
    name: str
    model: str

    def stream(
        self, messages: list[dict], tools: list[dict] | None, *, temperature: float, max_tokens: int
    ) -> AsyncIterator[LLMEvent]: ...

    async def complete(self, messages: list[dict], *, max_tokens: int = 8) -> str: ...

    async def aclose(self) -> None: ...


# --------------------------------------------------------------------------- #
# OpenAI-compatible (OpenAI, Groq, Cerebras, Together, Ollama)
# --------------------------------------------------------------------------- #
ENDPOINTS: dict[str, tuple[str, str, str]] = {
    # provider: (base_url, default_model, key attr)
    "openai": ("https://api.openai.com/v1", "gpt-4o-mini", "openai_key"),
    "groq": ("https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "groq_key"),
    "cerebras": ("https://api.cerebras.ai/v1", "llama-3.3-70b", "cerebras_key"),
    "together": ("https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "together_key"),
}


class OpenAICompatLLM:
    def __init__(self, name: str, base_url: str, api_key: str, model: str) -> None:
        from openai import AsyncOpenAI

        self.name, self.model = name, model
        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key or "not-needed", timeout=60, max_retries=0)

    async def stream(
        self, messages: list[dict], tools: list[dict] | None, *, temperature: float, max_tokens: int
    ) -> AsyncIterator[LLMEvent]:
        kwargs: dict[str, Any] = dict(
            model=self.model, messages=messages, stream=True, temperature=temperature, max_tokens=max_tokens,
            stream_options={"include_usage": True},
        )
        if tools:
            kwargs["tools"] = tools
        stream = await self._client.chat.completions.create(**kwargs)
        pending: dict[int, dict[str, str]] = {}
        try:
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    u = chunk.usage
                    yield LLMEvent("usage", usage={"prompt_tokens": u.prompt_tokens or 0, "completion_tokens": u.completion_tokens or 0})
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if delta.content:
                    yield LLMEvent("text", text=delta.content)
                for tc in delta.tool_calls or []:
                    slot = pending.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["args"] += tc.function.arguments
            for i in sorted(pending):
                s = pending[i]
                try:
                    args = json.loads(s["args"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield LLMEvent("tool_call", tool=ToolCall(s["id"] or f"call_{i}", s["name"], args))
        finally:
            with contextlib.suppress(Exception):
                await stream.close()  # barge-in: abort the in-flight HTTP request

    async def complete(self, messages: list[dict], *, max_tokens: int = 8) -> str:
        r = await self._client.chat.completions.create(
            model=self.model, messages=messages, max_tokens=max_tokens, temperature=0
        )
        return (r.choices[0].message.content or "").strip()

    async def aclose(self) -> None:
        with contextlib.suppress(Exception):
            await self._client.close()


# --------------------------------------------------------------------------- #
# Anthropic
# --------------------------------------------------------------------------- #
def _to_anthropic(messages: list[dict]) -> tuple[str, list[dict]]:
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    out: list[dict] = []
    for m in messages:
        if m["role"] == "system":
            continue
        if m["role"] == "assistant" and m.get("tool_calls"):
            blocks: list[dict] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["function"]["name"],
                               "input": json.loads(tc["function"]["arguments"] or "{}")})
            out.append({"role": "assistant", "content": blocks})
        elif m["role"] == "tool":
            block = {"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
        else:
            out.append({"role": m["role"], "content": m["content"] or "…"})
    return system, out


class AnthropicLLM:
    name = "anthropic"

    def __init__(self, model: str) -> None:
        from anthropic import AsyncAnthropic

        self.model = model or "claude-haiku-5-5"
        self._client = AsyncAnthropic(api_key=settings.anthropic_key, max_retries=0)

    async def stream(
        self, messages: list[dict], tools: list[dict] | None, *, temperature: float, max_tokens: int
    ) -> AsyncIterator[LLMEvent]:
        system, msgs = _to_anthropic(messages)
        a_tools = [
            {"name": t["function"]["name"], "description": t["function"].get("description", ""),
             "input_schema": t["function"]["parameters"]}
            for t in (tools or [])
        ]
        kwargs: dict[str, Any] = dict(model=self.model, system=system, messages=msgs, max_tokens=max_tokens,
                                      temperature=temperature)
        if a_tools:
            kwargs["tools"] = a_tools
        async with self._client.messages.stream(**kwargs) as s:
            async for ev in s:
                if ev.type == "content_block_delta" and getattr(ev.delta, "type", "") == "text_delta":
                    yield LLMEvent("text", text=ev.delta.text)
            final = await s.get_final_message()
        for b in final.content:
            if b.type == "tool_use":
                yield LLMEvent("tool_call", tool=ToolCall(b.id, b.name, dict(b.input)))
        yield LLMEvent("usage", usage={"prompt_tokens": final.usage.input_tokens, "completion_tokens": final.usage.output_tokens})

    async def complete(self, messages: list[dict], *, max_tokens: int = 8) -> str:
        system, msgs = _to_anthropic(messages)
        r = await self._client.messages.create(model=self.model, system=system, messages=msgs, max_tokens=max_tokens, temperature=0)
        return "".join(b.text for b in r.content if b.type == "text").strip()

    async def aclose(self) -> None:
        with contextlib.suppress(Exception):
            await self._client.close()


# --------------------------------------------------------------------------- #
# Availability helpers + factory
# --------------------------------------------------------------------------- #
def ollama_models() -> list[str]:
    try:
        r = httpx.get(f"{settings.ollama_url}/api/tags", timeout=1.5)
        r.raise_for_status()
        names = [m["name"] for m in r.json().get("models", [])]
        return [n for n in names if "embed" not in n]
    except Exception:
        return []


def create_llm(provider: str, model: str, mock_profile: str = "gpt-4o-mini", persona: str = "restaurant") -> LLMProvider:
    if provider == "mock":
        from .mock import MockLLM

        return MockLLM(mock_profile, persona)
    if provider == "ollama":
        names = ollama_models()
        m = model or (names[0] if names else "llama3.2")
        return OpenAICompatLLM("ollama", f"{settings.ollama_url}/v1", "ollama", m)
    if provider == "anthropic":
        return AnthropicLLM(model)
    base, default_model, key_attr = ENDPOINTS[provider]
    return OpenAICompatLLM(provider, base, getattr(settings, key_attr), model or default_model)
