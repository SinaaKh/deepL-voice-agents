"""A transparent, rule-based stand-in for LiveKit's transformer turn detector.

The real model (LiveKit `turn-detector`, a small fine-tuned transformer) is used in
`livekit_agent/agent.py`. This one is deliberately inspectable so the Turn-Taking Lab can
explain *why* it thinks a thought is unfinished. Like the real model it:
  * ignores punctuation and casing (STT punctuation is unreliable mid-pause)
  * looks at the end of the text, where unfinished thoughts give themselves away
  * peeks at the previous agent turn (is the user answering a question?)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_PUNCT = re.compile(r"[^\w\s'’-]")

CONJUNCTIONS = {"and", "but", "or", "so", "because", "if", "then", "that", "which", "while",
                "although", "though", "plus", "also", "since", "unless", "until", "when", "whenever"}
PREPOSITIONS = {"for", "to", "at", "on", "in", "with", "of", "from", "by", "about", "into",
                "around", "between", "after", "before", "during", "through", "under", "near", "toward"}
DETERMINERS = {"a", "an", "the", "my", "your", "our", "his", "her", "their", "some", "any",
               "this", "these", "those", "another", "every", "each"}
AUXILIARIES = {"is", "are", "was", "were", "am", "can", "could", "would", "will", "should",
               "shall", "may", "might", "must", "do", "does", "did", "have", "has", "had",
               "i'd", "i'll", "i'm", "i've", "we'd", "we'll", "we're", "it's", "that's", "there's",
               "he's", "she's", "they're", "you're", "let's", "gonna", "wanna", "going", "trying"}
FRAME_VERBS = {"want", "need", "like", "wish", "hope", "think", "guess", "mean", "wondering",
               "looking", "calling", "booking", "reserve", "book", "make", "get", "have", "bring",
               "tell", "say", "know", "see", "feel", "feeling", "been", "having", "take"}
FILLERS = {"um", "uh", "er", "erm", "hmm", "mm", "ah", "like", "well", "okay so", "you know", "i mean", "kinda", "sorta", "basically"}
PRONOUNS_ALONE = {"i", "we", "you", "he", "she", "they", "it"}
ACKS = {"yes", "yeah", "yep", "no", "nope", "okay", "ok", "sure", "thanks", "thank you", "correct",
        "right", "exactly", "that's right", "that's it", "goodbye", "bye", "perfect", "great",
        "sounds good", "that works", "please do", "go ahead", "never mind", "nothing else", "that's all"}
INTERROGATIVES = ("what", "when", "where", "who", "why", "how", "which", "can you", "could you",
                  "would you", "do you", "does", "is there", "are there", "will you", "is it", "are you")

NUMBER_WORDS = {"zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"}


def normalize(text: str) -> str:
    t = _PUNCT.sub(" ", text.lower().replace("…", " ").replace("...", " "))
    return re.sub(r"\s+", " ", t).strip()


@dataclass
class Verdict:
    p_eot: float
    reasons: list[str] = field(default_factory=list)


class HeuristicSemanticDetector:
    name = "heuristic"

    def explain(self, transcript: str, history: list[dict] | None = None) -> Verdict:
        t = normalize(transcript)
        words = t.split()
        reasons: list[str] = []
        if not words:
            return Verdict(0.15, ["no words yet – probably noise or a breath"])

        last = words[-1]
        last2 = " ".join(words[-2:])
        agent_asked = False
        if history:
            for m in reversed(history):
                if m.get("role") == "assistant" and m.get("content"):
                    agent_asked = str(m["content"]).strip().endswith("?")
                    break

        # --- strong "unfinished" signals at the tail ------------------------------------
        if last in FILLERS or last2 in FILLERS:
            return Verdict(0.08, [f"ends with filler “{last}”"])
        if last in CONJUNCTIONS:
            return Verdict(0.10, [f"ends with conjunction “{last}”"])
        if last in PREPOSITIONS:
            return Verdict(0.12, [f"ends with preposition “{last}”"])
        if last in DETERMINERS:
            return Verdict(0.08, [f"ends with determiner “{last}”"])
        if last in AUXILIARIES:
            return Verdict(0.12, [f"ends with auxiliary/modal “{last}”"])
        if last in FRAME_VERBS and len(words) <= 6:
            return Verdict(0.14, [f"verb “{last}” still needs its object"])
        if len(words) == 1 and last in PRONOUNS_ALONE:
            return Verdict(0.05, ["lone pronoun"])

        # --- digit sequences (phone numbers, card digits, dates read aloud) ---------------
        digitish = [w for w in words if w.isdigit() or w in NUMBER_WORDS]
        if last in NUMBER_WORDS or last.isdigit():
            ctx = any(k in t for k in ("number", "phone", "digits", "code", "zip", "account", "card"))
            if ctx and len(digitish) < 7:
                return Verdict(0.2, [f"only {len(digitish)} digits so far – a phone/ID usually has more"])

        # --- strong "finished" signals -----------------------------------------------------
        if t in ACKS or last2 in ACKS or last in ACKS and len(words) <= 3:
            return Verdict(0.96, ["short acknowledgement"])
        if words[0] in {"what", "when", "where", "who", "why", "how", "which"} or t.startswith(INTERROGATIVES):
            if len(words) >= 4:
                return Verdict(0.9, ["complete-looking question"])
        if agent_asked and len(words) <= 6:
            return Verdict(0.9, ["short answer to the agent’s question"])

        # --- generic length-based prior ----------------------------------------------------
        if len(words) >= 5:
            reasons.append("grammatically complete-looking utterance")
            return Verdict(0.84, reasons)
        if len(words) >= 3:
            return Verdict(0.62, ["short but plausible complete phrase"])
        return Verdict(0.38, ["very short fragment"])

    def predict(self, transcript: str, history: list[dict] | None = None) -> float:
        return self.explain(transcript, history).p_eot
