from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    bvid: str
    title: str
    owner: str
    duration: int
    source: str
    segments: list[Segment] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "bvid": self.bvid,
            "title": self.title,
            "owner": self.owner,
            "duration": self.duration,
            "source": self.source,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text} for s in self.segments
            ],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Transcript":
        return cls(
            bvid=data["bvid"],
            title=data.get("title") or data["bvid"],
            owner=data.get("owner") or "",
            duration=int(data.get("duration") or 0),
            source=data.get("source") or "unknown",
            segments=[
                Segment(float(item["start"]), float(item["end"]), item["text"])
                for item in data.get("segments", [])
            ],
        )

    def to_srt(self) -> str:
        blocks = []
        for index, segment in enumerate(self.segments, start=1):
            blocks.append(
                f"{index}\n{_srt_time(segment.start)} --> {_srt_time(segment.end)}\n{segment.text}\n"
            )
        return "\n".join(blocks)


def _srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
