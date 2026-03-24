from pydantic import BaseModel

from app.services.json_parser import parse_json_response


class SamplePayload(BaseModel):
    action: str
    summary: str


def test_parse_json_response_handles_trailing_commas() -> None:
    text = """
    {
      "action": "ask",
      "summary": "Need more detail",
    }
    """

    parsed = parse_json_response(text, SamplePayload)

    assert parsed.action == "ask"
    assert parsed.summary == "Need more detail"


def test_parse_json_response_falls_back_to_yaml() -> None:
    text = """
    action: assume_ready
    summary: Ready to continue
    """

    parsed = parse_json_response(text, SamplePayload)

    assert parsed.action == "assume_ready"
    assert parsed.summary == "Ready to continue"
