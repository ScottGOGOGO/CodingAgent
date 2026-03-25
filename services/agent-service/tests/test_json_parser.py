from pydantic import BaseModel

from app.models import StructuredSpecOutput
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


def test_parse_json_response_coerces_object_shaped_data_model_fields() -> None:
    text = """
    {
      "title": "Basketball Study Guide",
      "summary": "Plan drills and concepts to learn.",
      "goal": "Help a beginner improve basketball fundamentals.",
      "targetUsers": ["Beginner players"],
      "screens": [],
      "coreFlows": [],
      "dataModelNeeds": [
        {
          "entity": "Drill",
          "fields": [
            {"name": "title", "type": "string"},
            {"name": "difficulty", "type": "enum"},
            {"name": "notes", "description": "Short coaching guidance"}
          ],
          "notes": "Store reusable practice drills."
        }
      ],
      "integrations": [],
      "brandAndVisualDirection": "Energetic coaching board",
      "constraints": [],
      "successCriteria": [],
      "assumptions": []
    }
    """

    parsed = parse_json_response(text, StructuredSpecOutput)

    assert parsed.data_model_needs[0].fields == [
        "title (string)",
        "difficulty (enum)",
        "notes: Short coaching guidance",
    ]


def test_parse_json_response_coerces_string_shaped_data_model_needs() -> None:
    text = """
    {
      "title": "Basketball Study Guide",
      "summary": "Plan drills and concepts to learn.",
      "goal": "Help a beginner improve basketball fundamentals.",
      "targetUsers": ["Beginner players"],
      "screens": [],
      "coreFlows": [],
      "dataModelNeeds": [
        "Drill: title (string), difficulty (enum)",
        "PracticeNote"
      ],
      "integrations": [],
      "brandAndVisualDirection": "Energetic coaching board",
      "constraints": [],
      "successCriteria": [],
      "assumptions": []
    }
    """

    parsed = parse_json_response(text, StructuredSpecOutput)

    assert parsed.data_model_needs[0].entity == "Drill"
    assert parsed.data_model_needs[0].fields == ["title (string)", "difficulty (enum)"]
    assert parsed.data_model_needs[1].entity == "PracticeNote"
    assert parsed.data_model_needs[1].fields == []
