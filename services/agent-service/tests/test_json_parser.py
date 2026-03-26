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


def test_parse_json_response_coerces_string_shaped_spec_sections() -> None:
    text = """
    {
      "title": "网球学习助手",
      "summary": "帮助零基础用户开始训练。",
      "goal": "让用户逐步完成入门学习。",
      "targetUsers": "零基础网球用户",
      "screens": [
        "登录/注册页面",
        {
          "title": "个人仪表盘页面",
          "sections": "进度概览"
        }
      ],
      "coreFlows": [
        "完成注册",
        {
          "title": "开始训练",
          "steps": {
            "description": "选择训练目标"
          },
          "result": "成功进入训练页"
        }
      ],
      "dataModelNeeds": {
        "entity": "用户",
        "fields": {
          "name": "昵称",
          "type": "string"
        }
      },
      "integrations": "视频服务",
      "brandAndVisualDirection": "清爽运动感",
      "constraints": "移动端优先",
      "successCriteria": {
        "label": "完成首个训练日"
      },
      "assumptions": "用户具备联网能力"
    }
    """

    parsed = parse_json_response(text, StructuredSpecOutput)

    assert parsed.target_users == ["零基础网球用户"]
    assert parsed.screens[0].name == "登录/注册页面"
    assert parsed.screens[0].elements == []
    assert parsed.screens[1].name == "个人仪表盘页面"
    assert parsed.screens[1].elements == ["进度概览"]
    assert parsed.core_flows[0].name == "完成注册"
    assert parsed.core_flows[0].steps == []
    assert parsed.core_flows[1].steps == ["选择训练目标"]
    assert parsed.core_flows[1].success == "成功进入训练页"
    assert parsed.data_model_needs[0].entity == "用户"
    assert parsed.data_model_needs[0].fields == ["昵称 (string)"]
    assert parsed.integrations == ["视频服务"]
    assert parsed.constraints == ["移动端优先"]
    assert parsed.success_criteria == ["完成首个训练日"]
    assert parsed.assumptions == ["用户具备联网能力"]


def test_parse_json_response_accepts_block_content_lists() -> None:
    content = [
        {"type": "text", "text": "{\"action\":\"ready\",\"summary\":\"可以开始\"}"},
    ]

    parsed = parse_json_response(content, SamplePayload)

    assert parsed.action == "ready"
    assert parsed.summary == "可以开始"
