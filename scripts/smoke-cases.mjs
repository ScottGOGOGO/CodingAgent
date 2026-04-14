export const SMOKE_CASES = [
  {
    name: "direct_ready",
    prompt:
      "帮我生成一个中文移动优先的上海三天两晚旅行规划 Web 应用，面向两位成年人在节假日出行，住在静安寺附近，节奏偏轻松休闲。首版必须包含这些页面和流程：首页概览、按天行程页、地点详情页、预算页、收藏清单页；核心流程是浏览三天行程、查看地点详情、按天气切换备选方案、收藏地点、查看预算汇总。推荐内容先用高质量静态精选数据做原型，不需要接真实接口。数据模型只需要行程日、地点卡片、预算条目和收藏项。整体视觉做成文艺旅行手帐风，主色偏米白、墨绿和一点暖金，动效保持轻微。预算只统计餐饮、门票和市内交通，不含住宿。收藏清单只需要浏览器本地保存，不要登录、支付或后台管理。成功标准是用户能在 3 分钟内看完三天路线并完成收藏。重点区域默认静安、黄浦、徐汇，内容风格实用攻略和氛围种草均衡，每天默认安排 2 个核心景点和 2 个餐饮点，收藏页支持按类型筛选和标记必去。",
    expectedInitialStatus: "awaiting_approval",
  },
  {
    name: "clarify_then_ready",
    prompt: "帮我做一个上海旅游攻略 web 应用。",
    expectedInitialStatus: "clarifying",
  },
];

const GENERIC_CLARIFICATION_REPLY = [
  "1. 三天两晚，节假日出行，下周五出发。",
  "2. 住静安区，行程以静安、黄浦、徐汇一带为主。",
  "3. 两位成年人，偏轻松休闲，喜欢美术馆、梧桐区散步、本帮菜、咖啡店和夜景，预算中等偏上。",
].join("\n");

function questionText(question) {
  return [question?.question, question?.placeholder, question?.rationale]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function answerClarificationQuestion(question) {
  const text = questionText(question);

  if (!text) {
    return "三天两晚，住静安区，两位成年人，偏轻松休闲，喜欢美术馆、梧桐区、本帮菜和咖啡店。";
  }

  if (/几天|几晚|多久|时间|日期|什么时候|出发|节假日|周末/.test(text)) {
    return "三天两晚，节假日出行，下周五出发。";
  }

  if (/住|酒店|区域|静安|黄浦|徐汇|浦东|在哪/.test(text)) {
    return "住静安区，路线以静安、黄浦、徐汇一带为主。";
  }

  if (/谁用|目标用户|几个人|同行|情侣|家庭|成人|学生/.test(text)) {
    return "两位成年人一起出行，不带小孩。";
  }

  if (/预算|花费|消费|价格/.test(text)) {
    return "预算中等偏上，愿意为美术馆、好吃的餐厅和舒适咖啡店多花一点。";
  }

  if (/风格|节奏|轻松|休闲|特种兵|体验|偏好|喜欢/.test(text)) {
    return "整体偏轻松休闲，不想赶景点，喜欢美术馆、梧桐区散步、夜景和咖啡店。";
  }

  if (/吃|餐厅|本帮菜|咖啡|美食/.test(text)) {
    return "希望重点推荐本帮菜、咖啡店和适合拍照的甜品店。";
  }

  if (/must|必须|功能|页面|内容|首版|需要/.test(text)) {
    return "首版需要每日行程、地图通勤提示、景点和美术馆推荐、餐饮清单、预算估算和雨天备选。";
  }

  return "三天两晚，住静安区，两位成年人，偏轻松休闲，喜欢美术馆、梧桐区、本帮菜和咖啡店。";
}

export function buildClarificationAnswers(questions) {
  return (questions ?? []).map((question) => ({
    questionId: question.id,
    answer: answerClarificationQuestion(question),
  }));
}

export function buildClarificationReplyText(questions) {
  if (!questions?.length) {
    return GENERIC_CLARIFICATION_REPLY;
  }

  return questions
    .map((question, index) => `${index + 1}. ${answerClarificationQuestion(question)}`)
    .join("\n");
}
