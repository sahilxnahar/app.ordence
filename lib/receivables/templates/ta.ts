/**
 * Ordence — Demand Notice Templates: Tamil (தமிழ்)
 * Version: v0.38.0-alpha
 *
 * ⚠️ `amountInWords` IS `null`. Tamil numerals below 100 are not
 * compositional and the compound forms above them change shape when
 * joined — the words for three lakh are not "மூன்று" and "லட்சம்"
 * written side by side in every context. A generated approximation would
 * be wrong on the part of an Indian financial document that
 * conventionally prevails over the figures.
 *
 * See `kn.ts` for the full argument. The words fall back to the figures
 * in Indian grouping, `words_fell_back` is recorded, and the gap is
 * reportable rather than invisible.
 */

import type { NoticeTemplatePack } from "./contract";

export const TA_PACK: NoticeTemplatePack = {
  language: "ta",
  version: "1.0.0",
  endonym: "தமிழ்",
  amountInWords: null,

  demand: {
    subject: "கோரிக்கை அறிவிப்பு {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
    body: [
      "{{developerName}}",
      "",
      "கோரிக்கை அறிவிப்பு",
      "அறிவிப்பு எண் {{noticeNumber}}    நாள்: {{noticeDate}}",
      "",
      "பெறுநர்: {{buyerName}}",
      "அலகு: {{unitLabel}}, {{projectName}}",
      "",
      "அன்புள்ள {{buyerName}} அவர்களுக்கு,",
      "",
      "மேற்குறிப்பிட்ட அலகு தொடர்பான விற்பனை ஒப்பந்தத்தின்படி, கட்டுமானத்தின்",
      "பின்வரும் கட்டம் நிறைவடைந்ததால் இந்தக் கோரிக்கை விடுக்கப்படுகிறது:",
      "",
      "    {{triggerLabel}}",
      "    நிறைவடைந்த நாள்: {{triggerAchievedOn}}",
      "",
      "பின்வரும் தொகை இப்போது செலுத்த வேண்டியுள்ளது:",
      "",
      "    தவணை                           {{principalAmount}}",
      "    ஜிஎஸ்டி                         {{taxAmount}}",
      "    மொத்தம் செலுத்த வேண்டியது       {{totalAmount}}",
      "",
      "    ({{amountInWords}})",
      "",
      "செலுத்த வேண்டிய கடைசி நாள்: {{dueDate}}",
      "",
      "{{interestBasis}}",
      "",
      "ஏற்கெனவே பணம் செலுத்தியிருந்தால், இந்த அறிவிப்பை திரும்பப் பெறப்பட்டதாகக்",
      "கருதி, உங்கள் கணக்கைப் புதுப்பிக்க பணம் செலுத்திய விவரங்களை எங்களுக்கு",
      "அனுப்பவும்.",
      "",
      "{{contactLine}}",
    ].join("\n"),
  },

  stages: {
    reminder: {
      subject: "நினைவூட்டல்: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "அன்புள்ள {{buyerName}} அவர்களுக்கு,",
        "",
        "{{projectName}} இல் உள்ள {{unitLabel}} அலகுக்காக {{triggerLabel}}",
        "({{triggerAchievedOn}} அன்று நிறைவடைந்தது) அடிப்படையில் {{noticeDate}}",
        "அன்று வழங்கப்பட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொகை {{dueDate}}",
        "அன்று செலுத்தப்பட வேண்டியிருந்தது என்பதை நினைவூட்டுகிறோம்.",
        "",
        "    நிலுவைத் தொகை                  {{outstandingAmount}}",
        "    இன்றுவரை வட்டி                  {{interestAmount}}",
        "    இன்று செலுத்த வேண்டியது         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "ஏற்கெனவே பணம் செலுத்தியிருந்தால் இந்த நினைவூட்டலைப் புறக்கணித்து,",
        "விவரங்களை எங்களுக்கு அனுப்பவும்.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    first_notice: {
      subject: "முதல் அறிவிப்பு: {{noticeNumber}} நிலுவை — {{unitLabel}}",
      body: [
        "{{developerName}}",
        "",
        "முதல் அறிவிப்பு",
        "{{noticeDate}} நாளிட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொடர்பாக",
        "",
        "பெறுநர்: {{buyerName}}",
        "அலகு: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} அன்று நிறைவடைந்தது) அடிப்படையில்",
        "வழங்கப்பட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொகை {{dueDate}} அன்று",
        "செலுத்தப்பட வேண்டியிருந்தது; {{daysOverdue}} நாட்களுக்குப் பிறகும்",
        "கிடைக்கவில்லை.",
        "",
        "    நிலுவைத் தொகை                  {{outstandingAmount}}",
        "    இன்றுவரை வட்டி                  {{interestAmount}}",
        "    இன்று செலுத்த வேண்டியது         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "மேற்கண்ட தொகையைச் செலுத்தவும். அதில் ஏதேனும் ஒரு பகுதி மறுக்கப்பட்டால்,",
        "விவகாரம் மேலும் தொடர்வதற்கு முன் தீர்க்கப்படும் வகையில் எங்களுக்கு எழுதவும்.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    final_notice: {
      subject: "இறுதி அறிவிப்பு: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "இறுதி அறிவிப்பு",
        "{{noticeDate}} நாளிட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொடர்பாக",
        "",
        "பெறுநர்: {{buyerName}}",
        "அலகு: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} அன்று நிறைவடைந்தது) அடிப்படையில்",
        "வழங்கப்பட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொகை {{dueDate}} அன்று",
        "செலுத்தப்பட வேண்டியிருந்தது; இப்போது {{daysOverdue}} நாட்கள் தாமதம்.",
        "இதற்கு முன் நினைவூட்டலும் முதல் அறிவிப்பும் அனுப்பப்பட்டுள்ளன.",
        "",
        "    நிலுவைத் தொகை                  {{outstandingAmount}}",
        "    இன்றுவரை வட்டி                  {{interestAmount}}",
        "    இன்று செலுத்த வேண்டியது         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "தொகை கிடைக்கவில்லை என்றால், விற்பனை ஒப்பந்தம் மற்றும் ரியல் எஸ்டேட்",
        "(ஒழுங்குமுறை மற்றும் மேம்பாடு) சட்டம், 2016 இன்படி மேற்கண்ட அலகின் ஒதுக்கீட்டை",
        "ரத்து செய்வது பரிசீலிக்கப்படலாம். உங்களுக்கு ஏதேனும் சிரமம் இருந்தால்",
        "எங்களைத் தொடர்பு கொள்ளவும் — பதிவு செய்யப்பட்ட ஏற்பாடு இருதரப்புக்கும்",
        "ரத்தை விடச் சிறந்தது.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    cancellation_warning: {
      subject: "ஒதுக்கீடு ரத்துக்கு முந்தைய அறிவிப்பு: {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "ஒதுக்கீடு ரத்துக்கு முந்தைய அறிவிப்பு",
        "{{noticeDate}} நாளிட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொடர்பாக",
        "",
        "பெறுநர்: {{buyerName}}",
        "அலகு: {{unitLabel}}, {{projectName}}",
        "",
        "{{triggerLabel}} ({{triggerAchievedOn}} அன்று நிறைவடைந்தது) அடிப்படையில்",
        "வழங்கப்பட்ட கோரிக்கை அறிவிப்பு {{noticeNumber}} தொகை {{dueDate}} அன்று",
        "செலுத்தப்பட வேண்டியிருந்தது; {{daysOverdue}} நாட்கள் தாமதமாகிவிட்டது.",
        "நினைவூட்டல், முதல் அறிவிப்பு மற்றும் இறுதி அறிவிப்பு அனுப்பப்பட்டன; எந்தப்",
        "பணமும் கிடைக்கவில்லை.",
        "",
        "    நிலுவைத் தொகை                  {{outstandingAmount}}",
        "    இன்றுவரை வட்டி                  {{interestAmount}}",
        "    இன்று செலுத்த வேண்டியது         {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "மேற்கண்ட தொகை கிடைக்காவிட்டால், விற்பனை ஒப்பந்தத்தின்படி குறிப்பிட்ட அலகின்",
        "ஒதுக்கீடு ரத்து செய்யப்படலாம் என்றும், அந்த ஒப்பந்தத்தில் குறிப்பிடப்பட்டுள்ள",
        "விளைவுகள் — சட்டம் அனுமதிக்கும் அளவுக்கு பறிமுதல் உட்பட — பொருந்தும் என்றும்",
        "இதன்மூலம் அறிவிக்கப்படுகிறது.",
        "",
        "இந்த அறிவிப்பு உங்கள் கணக்கைப் பரிசீலித்த பிறகு வழங்கப்படுகிறது, தானாக அல்ல.",
        "தொகை செலுத்த வேண்டியதில்லை என்பதற்கு ஏதேனும் காரணம் இருந்தால், அல்லது ஒரு",
        "கால அட்டவணையை முன்மொழிய விரும்பினால், உடனடியாக எங்களுக்கு எழுதவும்; எந்த",
        "நடவடிக்கையும் எடுப்பதற்கு முன் அது பரிசீலிக்கப்படும்.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },
  },

  interestBasis: {
    sentence:
      "நிலுவையில் உள்ள அசல் தொகைக்கு ஆண்டுக்கு {{rate}} வீதம் வட்டி, {{rule}}, {{from}}, {{count}} அடிப்படையில் விதிக்கப்படும்.",
    none: "இந்தக் கோரிக்கைக்கு வட்டி ஏதும் விதிக்கப்படாது.",
    fromDueDate: "செலுத்த வேண்டிய நாள் {{dueDate}} முதல்",
    fromGraceEnd:
      "{{graceEnds}} முதல் ({{dueDate}} முதல் {{graceDays}} நாட்கள் சலுகைக் காலம், அதற்கு வட்டி இல்லை)",
    graceCharged:
      "செலுத்த வேண்டிய நாள் {{dueDate}} முதல், அந்த நாளிலிருந்து {{graceDays}} நாட்களுக்குள் பணம் செலுத்தப்படாவிட்டால் மட்டும்",
    compounding: {
      simple: "தனி வட்டி",
      monthly: "மாதாந்திர கூட்டு வட்டி",
      quarterly: "காலாண்டு கூட்டு வட்டி",
      annual: "ஆண்டு கூட்டு வட்டி",
    },
    dayCount: {
      actual_365: "365 நாள் ஆண்டில் உண்மையான நாட்கள்",
      actual_360: "360 நாள் ஆண்டில் உண்மையான நாட்கள்",
      thirty_360: "360 நாள் ஆண்டில் 30 நாள் மாதம்",
    },
  },
};
