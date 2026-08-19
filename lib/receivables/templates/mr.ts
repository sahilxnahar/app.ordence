/**
 * Ordence — Demand Notice Templates: Marathi (मराठी)
 * Version: v0.38.0-alpha
 *
 * ⚠️ `amountInWords` IS `null`, AND MARATHI IS THE CASE THAT PROVES THE
 * RULE IS ABOUT CORRECTNESS AND NOT ABOUT SCRIPT.
 *
 * Marathi is written in Devanagari, exactly like Hindi, and the two share
 * the scale words — लाख and कोटी. It would be very easy to reuse the
 * Hindi numerals here and produce something that LOOKS right to anybody
 * reviewing the diff.
 *
 * It would be wrong. Marathi's numerals below 100 are its own — 2 is
 * दोन and not दो, 9 is नऊ and not नौ, 20 is वीस and not बीस — and the
 * irregular forms in the forties to the nineties diverge further. A
 * Marathi notice carrying Hindi numerals is a document that reads, to its
 * recipient, as having been produced by somebody who did not know which
 * language they were writing in — on the part of an Indian financial
 * document that conventionally prevails over the figures.
 *
 * So the words fall back to figures in Indian grouping, `words_fell_back`
 * is recorded, and the gap is visible in a report rather than in a
 * buyer's hands. Reusing the neighbouring language's table because the
 * script matches is precisely the shortcut this file exists to refuse.
 */

import type { NoticeTemplatePack } from "./contract";

export const MR_PACK: NoticeTemplatePack = {
  language: "mr",
  version: "1.0.0",
  endonym: "मराठी",
  amountInWords: null,

  demand: {
    subject: "मागणी सूचना {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
    body: [
      "{{developerName}}",
      "",
      "मागणी सूचना",
      "सूचना क्रमांक {{noticeNumber}}    दिनांक: {{noticeDate}}",
      "",
      "प्रति: {{buyerName}}",
      "सदनिका: {{unitLabel}}, {{projectName}}",
      "",
      "प्रिय {{buyerName}},",
      "",
      "वरील सदनिकेसंदर्भात विक्री करारानुसार, बांधकामाचा खालील टप्पा पूर्ण",
      "झाल्यामुळे ही मागणी करण्यात येत आहे:",
      "",
      "    {{triggerLabel}}",
      "    पूर्ण झाल्याचा दिनांक: {{triggerAchievedOn}}",
      "",
      "खालील रक्कम आता देय आहे:",
      "",
      "    हप्ता                           {{principalAmount}}",
      "    जीएसटी                          {{taxAmount}}",
      "    एकूण देय                        {{totalAmount}}",
      "",
      "    ({{amountInWords}})",
      "",
      "देय दिनांक: {{dueDate}}",
      "",
      "{{interestBasis}}",
      "",
      "रक्कम आधीच भरली असल्यास कृपया ही सूचना मागे घेतल्याचे समजावे आणि आपले",
      "खाते अद्ययावत करण्यासाठी भरणा तपशील आम्हाला पाठवावेत.",
      "",
      "{{contactLine}}",
    ].join("\n"),
  },

  stages: {
    reminder: {
      subject: "स्मरणपत्र: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "प्रिय {{buyerName}},",
        "",
        "{{projectName}} मधील {{unitLabel}} सदनिकेसाठी {{triggerLabel}}",
        "({{triggerAchievedOn}} रोजी पूर्ण) या आधारे दिनांक {{noticeDate}} रोजी",
        "दिलेल्या मागणी सूचना {{noticeNumber}} ची रक्कम {{dueDate}} रोजी देय",
        "झाली आहे, याची आठवण करून देत आहोत.",
        "",
        "    थकबाकी                          {{outstandingAmount}}",
        "    आजपर्यंतचे व्याज                 {{interestAmount}}",
        "    आज देय रक्कम                    {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "रक्कम आधीच भरली असल्यास कृपया या स्मरणपत्राकडे दुर्लक्ष करावे आणि भरणा",
        "तपशील आम्हाला पाठवावेत.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    first_notice: {
      subject: "पहिली सूचना: {{noticeNumber}} थकीत — {{unitLabel}}",
      body: [
        "{{developerName}}",
        "",
        "पहिली सूचना",
        "दिनांक {{noticeDate}} च्या मागणी सूचना {{noticeNumber}} संदर्भात",
        "",
        "प्रति: {{buyerName}}",
        "सदनिका: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} रोजी पूर्ण) या आधारे दिलेल्या",
        "मागणी सूचना {{noticeNumber}} ची रक्कम {{dueDate}} रोजी देय होती आणि",
        "{{daysOverdue}} दिवसांनंतरही प्राप्त झालेली नाही.",
        "",
        "    थकबाकी                          {{outstandingAmount}}",
        "    आजपर्यंतचे व्याज                 {{interestAmount}}",
        "    आज देय रक्कम                    {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "कृपया वरील रक्कम भरावी. त्यातील कोणताही भाग वादग्रस्त असल्यास, प्रकरण",
        "पुढे जाण्यापूर्वी निकाली निघावे यासाठी आम्हाला लिहावे.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    final_notice: {
      subject: "अंतिम सूचना: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "अंतिम सूचना",
        "दिनांक {{noticeDate}} च्या मागणी सूचना {{noticeNumber}} संदर्भात",
        "",
        "प्रति: {{buyerName}}",
        "सदनिका: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} रोजी पूर्ण) या आधारे दिलेल्या",
        "मागणी सूचना {{noticeNumber}} ची रक्कम {{dueDate}} रोजी देय होती आणि आता",
        "{{daysOverdue}} दिवस थकीत आहे. यापूर्वी स्मरणपत्र व पहिली सूचना पाठवण्यात",
        "आली आहे.",
        "",
        "    थकबाकी                          {{outstandingAmount}}",
        "    आजपर्यंतचे व्याज                 {{interestAmount}}",
        "    आज देय रक्कम                    {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "रक्कम प्राप्त न झाल्यास, विक्री करार व स्थावर संपदा (नियमन आणि विकास)",
        "अधिनियम, 2016 नुसार वरील सदनिकेचे वाटप रद्द करण्याचा विचार केला जाऊ शकतो.",
        "आपल्याला काही अडचण असल्यास कृपया आमच्याशी संपर्क साधावा — नोंदवलेली",
        "व्यवस्था दोघांसाठीही रद्दीकरणापेक्षा चांगली असते.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    cancellation_warning: {
      subject: "वाटप रद्द करण्यापूर्वीची सूचना: {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "वाटप रद्द करण्यापूर्वीची सूचना",
        "दिनांक {{noticeDate}} च्या मागणी सूचना {{noticeNumber}} संदर्भात",
        "",
        "प्रति: {{buyerName}}",
        "सदनिका: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} रोजी पूर्ण) या आधारे दिलेल्या",
        "मागणी सूचना {{noticeNumber}} ची रक्कम {{dueDate}} रोजी देय होती आणि",
        "{{daysOverdue}} दिवस थकीत आहे. स्मरणपत्र, पहिली सूचना व अंतिम सूचना",
        "पाठवण्यात आल्या असून कोणताही भरणा प्राप्त झालेला नाही.",
        "",
        "    थकबाकी                          {{outstandingAmount}}",
        "    आजपर्यंतचे व्याज                 {{interestAmount}}",
        "    आज देय रक्कम                    {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "याद्वारे सूचित करण्यात येते की, वरील रक्कम प्राप्त न झाल्यास विक्री",
        "करारानुसार सदर सदनिकेचे वाटप रद्द होण्यास पात्र ठरेल आणि त्या करारात",
        "नमूद केलेले परिणाम — कायद्याने अनुज्ञेय मर्यादेपर्यंत जप्तीसह — लागू",
        "होतील.",
        "",
        "ही सूचना आपल्या खात्याचा विचार केल्यानंतर देण्यात आली आहे, आपोआप नाही.",
        "रक्कम देय नसल्याचे काही कारण असल्यास, अथवा आपण एखादे वेळापत्रक सुचवू",
        "इच्छित असल्यास, त्वरित आम्हाला लिहावे; कोणतीही पावले उचलण्यापूर्वी त्याचा",
        "विचार केला जाईल.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },
  },

  interestBasis: {
    sentence:
      "थकीत मुद्दलावर वार्षिक {{rate}} दराने व्याज, {{rule}}, {{from}}, {{count}} या आधारावर आकारले जाईल.",
    none: "या मागणीवर कोणतेही व्याज आकारले जाणार नाही.",
    fromDueDate: "देय दिनांक {{dueDate}} पासून",
    fromGraceEnd:
      "{{graceEnds}} पासून (देय दिनांक {{dueDate}} पासून {{graceDays}} दिवसांची सवलत, ज्यावर व्याज नाही)",
    graceCharged:
      "देय दिनांक {{dueDate}} पासून, त्या दिनांकापासून {{graceDays}} दिवसांत भरणा न झाल्यासच",
    compounding: {
      simple: "साधे व्याज",
      monthly: "मासिक चक्रवाढ",
      quarterly: "त्रैमासिक चक्रवाढ",
      annual: "वार्षिक चक्रवाढ",
    },
    dayCount: {
      actual_365: "365 दिवसांच्या वर्षातील प्रत्यक्ष दिवसांच्या",
      actual_360: "360 दिवसांच्या वर्षातील प्रत्यक्ष दिवसांच्या",
      thirty_360: "360 दिवसांच्या वर्षातील 30 दिवसांच्या महिन्याच्या",
    },
  },
};
