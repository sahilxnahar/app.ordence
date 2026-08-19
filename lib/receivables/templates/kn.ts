/**
 * Ordence — Demand Notice Templates: Kannada (ಕನ್ನಡ)
 * Version: v0.38.0-alpha
 *
 * ⭐ THE PACK THIS PRODUCT MOST NEEDS. The reference deployment is a
 * Bengaluru developer, and a Kannada-speaking buyer handed an English
 * demand takes it to somebody else to read — which adds days to every
 * collection and removes the developer from the conversation entirely.
 *
 * ⚠️ `amountInWords` IS `null`, DELIBERATELY, AND IT IS THE CENTRAL
 * DECISION OF THIS DIRECTORY.
 *
 * Kannada numerals below 100 are not compositional, and the compounds
 * above them are subject to sandhi — the joined form of "ಮೂರು" and
 * "ಲಕ್ಷ" is not the two words written next to each other. A generated
 * approximation would be wrong in a way no reviewer here can check, on
 * the part of an Indian financial document that CONVENTIONALLY PREVAILS
 * OVER THE FIGURES.
 *
 * A notice whose words say a different number to its figures is worse
 * than a notice with no words at all: the first is a legal document
 * stating an amount the developer never demanded, and the second is a
 * document in the buyer's language quoting a figure they can read.
 *
 * So the words fall back to the figures in Indian grouping,
 * `words_fell_back` is recorded on the stored document, and the gap is
 * reportable. When somebody who actually speaks Kannada writes the
 * numbering system, this becomes a function and nothing else changes.
 */

import type { NoticeTemplatePack } from "./contract";

export const KN_PACK: NoticeTemplatePack = {
  language: "kn",
  version: "1.0.0",
  endonym: "ಕನ್ನಡ",
  amountInWords: null,

  demand: {
    subject: "ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
    body: [
      "{{developerName}}",
      "",
      "ಬೇಡಿಕೆ ಸೂಚನೆ",
      "ಸೂಚನೆ ಸಂಖ್ಯೆ {{noticeNumber}}    ದಿನಾಂಕ: {{noticeDate}}",
      "",
      "ಇವರಿಗೆ: {{buyerName}}",
      "ಘಟಕ: {{unitLabel}}, {{projectName}}",
      "",
      "ಆತ್ಮೀಯ {{buyerName}} ಅವರೇ,",
      "",
      "ಮೇಲ್ಕಂಡ ಘಟಕಕ್ಕೆ ಸಂಬಂಧಿಸಿದ ಮಾರಾಟ ಒಪ್ಪಂದದ ಅನ್ವಯ, ನಿರ್ಮಾಣದ ಈ ಕೆಳಗಿನ ಹಂತವು",
      "ಪೂರ್ಣಗೊಂಡ ಕಾರಣ ಈ ಬೇಡಿಕೆಯನ್ನು ಮಂಡಿಸಲಾಗಿದೆ:",
      "",
      "    {{triggerLabel}}",
      "    ಪೂರ್ಣಗೊಂಡ ದಿನಾಂಕ: {{triggerAchievedOn}}",
      "",
      "ಈ ಕೆಳಗಿನ ಮೊತ್ತವು ಈಗ ಪಾವತಿಗೆ ಬಾಕಿ ಇದೆ:",
      "",
      "    ಕಂತು                           {{principalAmount}}",
      "    ಜಿಎಸ್‌ಟಿ                        {{taxAmount}}",
      "    ಒಟ್ಟು ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ         {{totalAmount}}",
      "",
      "    ({{amountInWords}})",
      "",
      "ಪಾವತಿಗೆ ಕೊನೆಯ ದಿನಾಂಕ: {{dueDate}}",
      "",
      "{{interestBasis}}",
      "",
      "ಈಗಾಗಲೇ ಪಾವತಿ ಮಾಡಿದ್ದರೆ ದಯವಿಟ್ಟು ಈ ಸೂಚನೆಯನ್ನು ಹಿಂಪಡೆದಿದೆ ಎಂದು ಪರಿಗಣಿಸಿ,",
      "ಮತ್ತು ನಿಮ್ಮ ಖಾತೆಯನ್ನು ನವೀಕರಿಸಲು ಪಾವತಿಯ ವಿವರಗಳನ್ನು ನಮಗೆ ಕಳುಹಿಸಿ.",
      "",
      "{{contactLine}}",
    ].join("\n"),
  },

  stages: {
    reminder: {
      subject: "ಜ್ಞಾಪನೆ: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "ಆತ್ಮೀಯ {{buyerName}} ಅವರೇ,",
        "",
        "{{projectName}} ನ {{unitLabel}} ಘಟಕಕ್ಕೆ {{triggerLabel}}",
        "({{triggerAchievedOn}} ರಂದು ಪೂರ್ಣಗೊಂಡಿದೆ) ಆಧಾರದ ಮೇಲೆ ದಿನಾಂಕ",
        "{{noticeDate}} ರಂದು ನೀಡಲಾದ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ರ ಪಾವತಿಯು",
        "{{dueDate}} ರಂದು ಬಾಕಿಯಾಗಿದೆ ಎಂಬುದನ್ನು ನೆನಪಿಸಲಾಗುತ್ತಿದೆ.",
        "",
        "    ಬಾಕಿ ಮೊತ್ತ                     {{outstandingAmount}}",
        "    ಇಂದಿನವರೆಗಿನ ಬಡ್ಡಿ               {{interestAmount}}",
        "    ಇಂದು ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "ಈಗಾಗಲೇ ಪಾವತಿ ಮಾಡಿದ್ದರೆ ಈ ಜ್ಞಾಪನೆಯನ್ನು ಕಡೆಗಣಿಸಿ, ಪಾವತಿಯ ವಿವರಗಳನ್ನು",
        "ನಮಗೆ ಕಳುಹಿಸಿ.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    first_notice: {
      subject: "ಮೊದಲ ಸೂಚನೆ: {{noticeNumber}} ಬಾಕಿ — {{unitLabel}}",
      body: [
        "{{developerName}}",
        "",
        "ಮೊದಲ ಸೂಚನೆ",
        "ದಿನಾಂಕ {{noticeDate}} ರ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ಕುರಿತು",
        "",
        "ಇವರಿಗೆ: {{buyerName}}",
        "ಘಟಕ: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} ರಂದು ಪೂರ್ಣಗೊಂಡಿದೆ) ಆಧಾರದ ಮೇಲೆ",
        "ನೀಡಲಾದ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ರ ಪಾವತಿಯು {{dueDate}} ರಂದು ಬಾಕಿಯಾಗಿ,",
        "{{daysOverdue}} ದಿನಗಳ ನಂತರವೂ ಸ್ವೀಕೃತವಾಗಿಲ್ಲ.",
        "",
        "    ಬಾಕಿ ಮೊತ್ತ                     {{outstandingAmount}}",
        "    ಇಂದಿನವರೆಗಿನ ಬಡ್ಡಿ               {{interestAmount}}",
        "    ಇಂದು ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "ದಯವಿಟ್ಟು ಮೇಲ್ಕಂಡ ಮೊತ್ತವನ್ನು ಪಾವತಿಸಿ. ಅದರ ಯಾವುದೇ ಭಾಗದ ಬಗ್ಗೆ ತಕರಾರು ಇದ್ದರೆ,",
        "ವಿಷಯವು ಮುಂದುವರಿಯುವ ಮೊದಲು ಇತ್ಯರ್ಥವಾಗುವಂತೆ ನಮಗೆ ಬರೆಯಿರಿ.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    final_notice: {
      subject: "ಅಂತಿಮ ಸೂಚನೆ: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "ಅಂತಿಮ ಸೂಚನೆ",
        "ದಿನಾಂಕ {{noticeDate}} ರ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ಕುರಿತು",
        "",
        "ಇವರಿಗೆ: {{buyerName}}",
        "ಘಟಕ: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} ರಂದು ಪೂರ್ಣಗೊಂಡಿದೆ) ಆಧಾರದ ಮೇಲೆ",
        "ನೀಡಲಾದ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ರ ಪಾವತಿಯು {{dueDate}} ರಂದು ಬಾಕಿಯಾಗಿ",
        "ಈಗ {{daysOverdue}} ದಿನಗಳಾಗಿವೆ. ಈ ಮೊದಲು ಜ್ಞಾಪನೆ ಮತ್ತು ಮೊದಲ ಸೂಚನೆ",
        "ಕಳುಹಿಸಲಾಗಿದೆ.",
        "",
        "    ಬಾಕಿ ಮೊತ್ತ                     {{outstandingAmount}}",
        "    ಇಂದಿನವರೆಗಿನ ಬಡ್ಡಿ               {{interestAmount}}",
        "    ಇಂದು ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "ಮೊತ್ತವು ಸ್ವೀಕೃತವಾಗದಿದ್ದಲ್ಲಿ, ಮಾರಾಟ ಒಪ್ಪಂದ ಮತ್ತು ರಿಯಲ್ ಎಸ್ಟೇಟ್ (ನಿಯಂತ್ರಣ",
        "ಮತ್ತು ಅಭಿವೃದ್ಧಿ) ಅಧಿನಿಯಮ, 2016 ರ ಪ್ರಕಾರ ಮೇಲ್ಕಂಡ ಘಟಕದ ಹಂಚಿಕೆಯನ್ನು ರದ್ದುಪಡಿಸುವ",
        "ಬಗ್ಗೆ ಪರಿಗಣಿಸಬಹುದು. ನಿಮಗೆ ಯಾವುದೇ ತೊಂದರೆ ಇದ್ದರೆ ದಯವಿಟ್ಟು ನಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸಿ —",
        "ದಾಖಲಾದ ಒಪ್ಪಂದವು ಇಬ್ಬರಿಗೂ ರದ್ದತಿಗಿಂತ ಉತ್ತಮ.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    cancellation_warning: {
      subject: "ಹಂಚಿಕೆ ರದ್ದತಿಗೂ ಮುನ್ನ ಸೂಚನೆ: {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "ಹಂಚಿಕೆ ರದ್ದತಿಗೂ ಮುನ್ನ ಸೂಚನೆ",
        "ದಿನಾಂಕ {{noticeDate}} ರ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ಕುರಿತು",
        "",
        "ಇವರಿಗೆ: {{buyerName}}",
        "ಘಟಕ: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} ರಂದು ಪೂರ್ಣಗೊಂಡಿದೆ) ಆಧಾರದ ಮೇಲೆ",
        "ನೀಡಲಾದ ಬೇಡಿಕೆ ಸೂಚನೆ {{noticeNumber}} ರ ಪಾವತಿಯು {{dueDate}} ರಂದು ಬಾಕಿಯಾಗಿ",
        "{{daysOverdue}} ದಿನಗಳಾಗಿವೆ. ಜ್ಞಾಪನೆ, ಮೊದಲ ಸೂಚನೆ ಮತ್ತು ಅಂತಿಮ ಸೂಚನೆ",
        "ಕಳುಹಿಸಲಾಗಿದ್ದು, ಯಾವುದೇ ಪಾವತಿ ಸ್ವೀಕೃತವಾಗಿಲ್ಲ.",
        "",
        "    ಬಾಕಿ ಮೊತ್ತ                     {{outstandingAmount}}",
        "    ಇಂದಿನವರೆಗಿನ ಬಡ್ಡಿ               {{interestAmount}}",
        "    ಇಂದು ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "ಮೇಲ್ಕಂಡ ಮೊತ್ತವು ಸ್ವೀಕೃತವಾಗದಿದ್ದಲ್ಲಿ, ಮಾರಾಟ ಒಪ್ಪಂದದ ಪ್ರಕಾರ ಸದರಿ ಘಟಕದ",
        "ಹಂಚಿಕೆಯನ್ನು ರದ್ದುಪಡಿಸಲಾಗುವುದು ಮತ್ತು ಆ ಒಪ್ಪಂದದಲ್ಲಿ ನಿಗದಿಪಡಿಸಿದ ಪರಿಣಾಮಗಳು —",
        "ಕಾನೂನು ಅನುಮತಿಸುವ ಮಟ್ಟಿಗೆ ಮುಟ್ಟುಗೋಲು ಸೇರಿದಂತೆ — ಅನ್ವಯವಾಗುತ್ತವೆ ಎಂದು",
        "ಸೂಚಿಸಲಾಗಿದೆ.",
        "",
        "ಈ ಸೂಚನೆಯನ್ನು ನಿಮ್ಮ ಖಾತೆಯನ್ನು ಪರಿಶೀಲಿಸಿದ ನಂತರ ನೀಡಲಾಗಿದೆ, ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಅಲ್ಲ.",
        "ಮೊತ್ತವು ಪಾವತಿಸಬೇಕಾಗಿಲ್ಲ ಎಂಬುದಕ್ಕೆ ಕಾರಣವಿದ್ದರೆ, ಅಥವಾ ಪಾವತಿ ವೇಳಾಪಟ್ಟಿಯನ್ನು",
        "ಪ್ರಸ್ತಾಪಿಸಲು ಬಯಸಿದರೆ, ತಕ್ಷಣ ನಮಗೆ ಬರೆಯಿರಿ; ಯಾವುದೇ ಕ್ರಮ ಕೈಗೊಳ್ಳುವ ಮೊದಲು ಅದನ್ನು",
        "ಪರಿಗಣಿಸಲಾಗುವುದು.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },
  },

  interestBasis: {
    sentence:
      "ಬಾಕಿ ಇರುವ ಅಸಲು ಮೊತ್ತದ ಮೇಲೆ ವಾರ್ಷಿಕ {{rate}} ದರದಲ್ಲಿ ಬಡ್ಡಿ, {{rule}}, {{from}}, {{count}} ಆಧಾರದ ಮೇಲೆ ವಿಧಿಸಲಾಗುತ್ತದೆ.",
    none: "ಈ ಬೇಡಿಕೆಯ ಮೇಲೆ ಯಾವುದೇ ಬಡ್ಡಿ ವಿಧಿಸಲಾಗುವುದಿಲ್ಲ.",
    fromDueDate: "ಪಾವತಿ ದಿನಾಂಕ {{dueDate}} ರಿಂದ",
    fromGraceEnd:
      "{{graceEnds}} ರಿಂದ (ಪಾವತಿ ದಿನಾಂಕ {{dueDate}} ರಿಂದ {{graceDays}} ದಿನಗಳ ರಿಯಾಯಿತಿ ಅವಧಿ, ಅದಕ್ಕೆ ಬಡ್ಡಿ ಇಲ್ಲ)",
    graceCharged:
      "ಪಾವತಿ ದಿನಾಂಕ {{dueDate}} ರಿಂದ, ಆ ದಿನಾಂಕದಿಂದ {{graceDays}} ದಿನಗಳೊಳಗೆ ಪಾವತಿ ಆಗದಿದ್ದರೆ ಮಾತ್ರ",
    compounding: {
      simple: "ಸರಳ ಬಡ್ಡಿ",
      quarterly: "ತ್ರೈಮಾಸಿಕ ಚಕ್ರಬಡ್ಡಿ",
      monthly: "ಮಾಸಿಕ ಚಕ್ರಬಡ್ಡಿ",
      annual: "ವಾರ್ಷಿಕ ಚಕ್ರಬಡ್ಡಿ",
    },
    dayCount: {
      actual_365: "365 ದಿನಗಳ ವರ್ಷದಲ್ಲಿ ನೈಜ ದಿನಗಳ",
      actual_360: "360 ದಿನಗಳ ವರ್ಷದಲ್ಲಿ ನೈಜ ದಿನಗಳ",
      thirty_360: "360 ದಿನಗಳ ವರ್ಷದಲ್ಲಿ 30 ದಿನಗಳ ತಿಂಗಳ",
    },
  },
};
