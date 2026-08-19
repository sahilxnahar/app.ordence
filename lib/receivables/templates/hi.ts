/**
 * Ordence — Demand Notice Templates: Hindi (हिन्दी)
 * Version: v0.38.0-alpha
 *
 * ⭐ HINDI IS ONE OF THE TWO PACKS WITH AMOUNT-IN-WORDS IMPLEMENTED.
 * `amountInWordsHindi` in `lib/receivables/numbers.ts` carries all
 * ninety-nine irregular numerals, because Hindi numbers below 100 are not
 * compositional and a generated "तीस एक" for 31 is not a number at all.
 *
 * ⚠️ THE FIGURES ARE IN ASCII DIGITS, NOT DEVANAGARI ONES. Indian legal
 * and banking documents use 5,00,000 and not ५,००,०००, whatever the
 * language of the text — a demand quoting Devanagari numerals cannot be
 * pasted into a bank transfer, and a buyer who has to transcribe it will
 * transcribe it wrong.
 */

import { amountInWordsHindi } from "../numbers";
import type { NoticeTemplatePack } from "./contract";

export const HI_PACK: NoticeTemplatePack = {
  language: "hi",
  version: "1.0.0",
  endonym: "हिन्दी",
  amountInWords: amountInWordsHindi,

  demand: {
    subject: "मांग सूचना {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
    body: [
      "{{developerName}}",
      "",
      "मांग सूचना",
      "सूचना संख्या {{noticeNumber}}    दिनांक: {{noticeDate}}",
      "",
      "सेवा में: {{buyerName}}",
      "इकाई: {{unitLabel}}, {{projectName}}",
      "",
      "प्रिय {{buyerName}},",
      "",
      "उपर्युक्त इकाई के संबंध में विक्रय अनुबंध के अंतर्गत, निर्माण के निम्नलिखित",
      "चरण के पूर्ण होने पर यह मांग की जा रही है:",
      "",
      "    {{triggerLabel}}",
      "    पूर्ण होने की तिथि: {{triggerAchievedOn}}",
      "",
      "निम्नलिखित राशि अब देय है:",
      "",
      "    किस्त                          {{principalAmount}}",
      "    जीएसटी                         {{taxAmount}}",
      "    कुल देय                        {{totalAmount}}",
      "",
      "    ({{amountInWords}})",
      "",
      "भुगतान की अंतिम तिथि: {{dueDate}}",
      "",
      "{{interestBasis}}",
      "",
      "यदि भुगतान पहले ही किया जा चुका है तो कृपया इस सूचना को निरस्त मानें और",
      "भुगतान का विवरण हमें भेजें, ताकि आपका खाता अद्यतन किया जा सके।",
      "",
      "{{contactLine}}",
    ].join("\n"),
  },

  stages: {
    reminder: {
      subject: "स्मरण पत्र: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "प्रिय {{buyerName}},",
        "",
        "यह स्मरण कराया जाता है कि दिनांक {{noticeDate}} की मांग सूचना",
        "{{noticeNumber}}, जो {{triggerLabel}} ({{triggerAchievedOn}} को पूर्ण) के",
        "आधार पर {{projectName}} की इकाई {{unitLabel}} हेतु जारी की गई थी,",
        "{{dueDate}} को देय हो चुकी है।",
        "",
        "    बकाया राशि                     {{outstandingAmount}}",
        "    आज तक का ब्याज                 {{interestAmount}}",
        "    आज देय कुल राशि                {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "यदि भुगतान पहले ही किया जा चुका है तो कृपया इस स्मरण पत्र को अनदेखा करें",
        "और भुगतान का विवरण हमें भेजें।",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    first_notice: {
      subject: "प्रथम सूचना: {{noticeNumber}} अतिदेय — {{unitLabel}}",
      body: [
        "{{developerName}}",
        "",
        "प्रथम सूचना",
        "दिनांक {{noticeDate}} की मांग सूचना {{noticeNumber}} के संबंध में",
        "",
        "सेवा में: {{buyerName}}",
        "इकाई: {{unitLabel}}, {{projectName}}",
        "",
        "मांग सूचना {{noticeNumber}}, जो {{triggerLabel}} ({{triggerAchievedOn}} को",
        "पूर्ण) के आधार पर जारी की गई थी, {{dueDate}} को देय थी और {{daysOverdue}}",
        "दिन बीत जाने पर भी अप्राप्त है।",
        "",
        "    बकाया राशि                     {{outstandingAmount}}",
        "    आज तक का ब्याज                 {{interestAmount}}",
        "    आज देय कुल राशि                {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "कृपया उपर्युक्त राशि का भुगतान करें, अथवा यदि इसका कोई भाग विवादित है तो",
        "हमें लिखें, जिससे मामला आगे बढ़ने से पहले सुलझाया जा सके।",
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
        "दिनांक {{noticeDate}} की मांग सूचना {{noticeNumber}} के संबंध में",
        "",
        "सेवा में: {{buyerName}}",
        "इकाई: {{unitLabel}}, {{projectName}}",
        "",
        "मांग सूचना {{noticeNumber}}, जो {{triggerLabel}} ({{triggerAchievedOn}} को",
        "पूर्ण) के आधार पर जारी की गई थी, {{dueDate}} को देय थी और अब",
        "{{daysOverdue}} दिन अतिदेय है। इससे पूर्व स्मरण पत्र तथा प्रथम सूचना भेजी",
        "जा चुकी है।",
        "",
        "    बकाया राशि                     {{outstandingAmount}}",
        "    आज तक का ब्याज                 {{interestAmount}}",
        "    आज देय कुल राशि                {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "राशि प्राप्त न होने की स्थिति में, विक्रय अनुबंध तथा रियल एस्टेट (विनियमन",
        "और विकास) अधिनियम, 2016 के अनुसार उपर्युक्त इकाई के आवंटन को निरस्त करने",
        "पर विचार किया जा सकता है। यदि आपको कोई कठिनाई है तो कृपया हमसे संपर्क करें —",
        "एक लिखित व्यवस्था दोनों पक्षों के लिए निरस्तीकरण से बेहतर है।",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    cancellation_warning: {
      subject: "आवंटन निरस्तीकरण से पूर्व सूचना: {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "आवंटन निरस्तीकरण से पूर्व सूचना",
        "दिनांक {{noticeDate}} की मांग सूचना {{noticeNumber}} के संबंध में",
        "",
        "सेवा में: {{buyerName}}",
        "इकाई: {{unitLabel}}, {{projectName}}",
        "",
        "मांग सूचना {{noticeNumber}}, जो {{triggerLabel}} ({{triggerAchievedOn}} को",
        "पूर्ण) के आधार पर जारी की गई थी, {{dueDate}} को देय थी और {{daysOverdue}}",
        "दिन अतिदेय है। स्मरण पत्र, प्रथम सूचना तथा अंतिम सूचना भेजी जा चुकी हैं और",
        "कोई भुगतान प्राप्त नहीं हुआ है।",
        "",
        "    बकाया राशि                     {{outstandingAmount}}",
        "    आज तक का ब्याज                 {{interestAmount}}",
        "    आज देय कुल राशि                {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "एतद्द्वारा सूचित किया जाता है कि उपर्युक्त राशि प्राप्त न होने पर, विक्रय",
        "अनुबंध के अनुसार उक्त इकाई का आवंटन निरस्त किया जा सकता है तथा उस अनुबंध",
        "में उल्लिखित परिणाम — विधि द्वारा अनुमत सीमा तक जब्ती सहित — लागू होंगे।",
        "",
        "यह सूचना आपके खाते पर विचार करने के उपरांत जारी की गई है, स्वतः नहीं। यदि",
        "राशि देय न होने का कोई कारण है, अथवा आप कोई भुगतान अनुसूची प्रस्तावित करना",
        "चाहते हैं, तो तत्काल हमें लिखें; कोई भी कदम उठाने से पूर्व उस पर विचार किया",
        "जाएगा।",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },
  },

  interestBasis: {
    sentence:
      "बकाया मूल राशि पर {{rate}} वार्षिक की दर से ब्याज, {{rule}}, {{from}}, {{count}} के आधार पर देय होगा।",
    none: "इस मांग पर कोई ब्याज नहीं लिया जाएगा।",
    fromDueDate: "देय तिथि {{dueDate}} से",
    fromGraceEnd:
      "{{graceEnds}} से (देय तिथि {{dueDate}} से {{graceDays}} दिन की छूट अवधि, जिस पर ब्याज नहीं लिया जाता)",
    graceCharged:
      "देय तिथि {{dueDate}} से, यदि उस तिथि से {{graceDays}} दिन के भीतर भुगतान नहीं किया जाता",
    compounding: {
      simple: "साधारण ब्याज",
      monthly: "मासिक चक्रवृद्धि",
      quarterly: "त्रैमासिक चक्रवृद्धि",
      annual: "वार्षिक चक्रवृद्धि",
    },
    dayCount: {
      actual_365: "365 दिन के वर्ष में वास्तविक दिनों",
      actual_360: "360 दिन के वर्ष में वास्तविक दिनों",
      thirty_360: "360 दिन के वर्ष में 30 दिन के माह",
    },
  },
};
