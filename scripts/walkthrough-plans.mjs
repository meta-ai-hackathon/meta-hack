// Typed-turn answer scripts for the v2 walkthrough journeys
// (walkthrough-core.mjs, VAL-WALK2-001/003).
//
// The conversation engine (src/lib/conversation.ts) asks one question at a
// time — the next unanswered question of the spec flow, computed
// server-side. Each plan step is the realistic sentence a person would
// type for that question; the server's structured extraction turns the
// words into a tri-state answer. The plans carry the same discipline as
// the wizard's JOURNEY_PLAN:
//
//   - no question classification is duplicated here: which questions are
//     pii comes from the served state payload, never from a hand-copy of
//     the spec;
//   - every value is fictional (the walkthrough persona: a North Carolina
//     resident with self-employment income and a stale prior-year W-2 —
//     the demo persona), and the private ones are submitted so their
//     redaction can be verified, never to be seen again in any body;
//   - the intended tri-state mix is explicit (intent), and the transcript
//     reports what the server actually recorded, honestly, when the
//     extraction heard something different.
//
// Pii values are typed in their canonical form (the bare date, the bare
// email) so the server's redaction sources match the typed words and the
// redaction-verification detector proves the substitution really happened.

/**
 * The conversational journey's turns (text mode), keyed by question id.
 * `text` is the realistic first phrasing; `retry` is the plainest possible
 * restatement used once when the extraction saved nothing for the question
 * the flow was asking. `intent` documents the intended tri-state mix.
 */
export const CONVERSATION_PLAN = [
  {
    id: "application_role",
    text: "It's for myself.",
    retry: "Me",
    intent: "known",
  },
  {
    id: "main_goal",
    text: "Health care coverage is what I need.",
    retry: "Health care",
    intent: "known",
  },
  {
    id: "state",
    text: "I live in North Carolina.",
    retry: "North Carolina",
    intent: "known",
  },
  {
    id: "county",
    text: "Mecklenburg County.",
    retry: "Mecklenburg County",
    intent: "known",
    privateValue: "Mecklenburg County",
  },
  {
    // The genuine-inference attempt: the value is derived, not stated, so
    // the honest server outcome is ai_drafted + unverified. Any honest
    // outcome passes — the transcript reports what was actually recorded.
    id: "household_size",
    text: "It's just me and my two kids, so three of us altogether.",
    retry: "Three",
    intent: "unverified",
  },
  {
    id: "household_children",
    text: "Two of them are kids.",
    retry: "Two",
    intent: "known",
  },
  {
    id: "household_seniors",
    text: "None of us is over 60.",
    retry: "Zero",
    intent: "known",
  },
  {
    id: "income_sources",
    text: "I do self-employed work, and I get benefits.",
    retry: "Self-employed and benefits",
    intent: "known",
  },
  {
    id: "income_kind",
    text: "I work for myself right now, in my own business, and I had a job before that I do not work at anymore.",
    retry: "Both — I work for myself now and had a job before",
    intent: "known",
  },
  {
    id: "self_employment_statements_offer",
    text: "I can share my bank statements.",
    retry: "Yes, I can share statements",
    intent: "known",
  },
  {
    id: "prior_employer_current",
    text: "No, I do not work there anymore.",
    retry: "No, I do not work there anymore",
    intent: "known",
  },
  {
    id: "prior_employer_last_month",
    text: "I last got paid in June 2025.",
    retry: "June 2025",
    intent: "known",
    privateValue: "June 2025",
  },
  {
    id: "job_income_amount",
    text: "About 1200 dollars each time I get paid.",
    retry: "1200",
    intent: "known",
  },
  {
    id: "job_income_frequency",
    text: "It comes in once a month.",
    retry: "Monthly",
    intent: "known",
  },
  {
    id: "benefits_income_amount",
    text: "I'm not sure.",
    retry: "I'm not sure",
    intent: "unknown",
  },
  {
    id: "benefits_income_frequency",
    text: "Once a month.",
    retry: "Monthly",
    intent: "known",
  },
  {
    id: "housing_status",
    text: "In a place I rent.",
    retry: "In a place I rent or own",
    intent: "known",
  },
  {
    id: "housing_cost",
    text: "About 1100 a month.",
    retry: "1100",
    intent: "known",
  },
  {
    id: "utilities_cost",
    text: "About 95 dollars a month.",
    retry: "95",
    intent: "known",
  },
  {
    id: "childcare_cost",
    text: "About 400 a month for child care.",
    retry: "400",
    intent: "known",
  },
  {
    id: "medical_cost",
    text: "I'm not sure.",
    retry: "I'm not sure",
    intent: "unknown",
  },
  {
    id: "id_status",
    text: "Yes, I have a photo ID.",
    retry: "I have one",
    intent: "known",
  },
  {
    id: "date_of_birth",
    text: "My date of birth is 1990-05-14.",
    retry: "1990-05-14",
    intent: "known",
    privateValue: "1990-05-14",
  },
  {
    id: "citizenship_status",
    text: "I'm a U.S. citizen.",
    retry: "U.S. citizen",
    intent: "known",
  },
  {
    id: "disability_status",
    text: "No.",
    retry: "No",
    intent: "known",
  },
  {
    id: "student_status",
    text: "I'm not in school.",
    retry: "No",
    intent: "known",
  },
  {
    id: "veteran_status",
    text: "No, I have never served in the military.",
    retry: "No",
    intent: "known",
  },
  {
    id: "received_benefits_before",
    text: "No, I have never gotten help from a benefits office.",
    retry: "No",
    intent: "known",
  },
  {
    id: "mailing_situation",
    text: "I use a P.O. box.",
    retry: "A P.O. box",
    intent: "known",
  },
  {
    id: "contact_preference",
    text: "Email is best.",
    retry: "Email",
    intent: "known",
  },
  {
    id: "email_contact",
    text: "My email is jamie.watts@example.com.",
    retry: "jamie.watts@example.com",
    intent: "known",
    privateValue: "jamie.watts@example.com",
  },
  {
    id: "best_time_to_reach",
    text: "Afternoons work best.",
    retry: "Afternoon",
    intent: "known",
  },
];

/**
 * The form-driven journey's turns: the same conversation engine, with the
 * answers chosen so the sample form's mapped fields pre-fill ("we already
 * know this") and its conditional fields exercise the skip behavior:
 * id_status = need_id asks the ID-problem detail, mailing_situation =
 * shelter asks the shelter-mail consent, and contact_preference = call
 * asks the phone while the email question is skipped by the flow — the
 * form's email field is then honestly NOT APPLICABLE on the review.
 */
export const FORM_JOURNEY_PLAN = [
  {
    id: "application_role",
    text: "It's for myself.",
    retry: "Me",
    intent: "known",
  },
  {
    id: "main_goal",
    text: "Food assistance.",
    retry: "Food",
    intent: "known",
  },
  {
    id: "state",
    text: "North Carolina.",
    retry: "North Carolina",
    intent: "known",
  },
  {
    id: "county",
    text: "Mecklenburg County.",
    retry: "Mecklenburg County",
    intent: "known",
    privateValue: "Mecklenburg County",
  },
  {
    // The genuine-inference attempt (see CONVERSATION_PLAN): the value is
    // derived from "me and my two kids", not stated as a number.
    id: "household_size",
    text: "It's me and my two kids, so three of us.",
    retry: "Three",
    intent: "unverified",
  },
  {
    id: "household_children",
    text: "Two.",
    retry: "Two",
    intent: "known",
  },
  {
    id: "household_seniors",
    text: "Zero.",
    retry: "Zero",
    intent: "known",
  },
  {
    id: "income_sources",
    text: "Self-employed work, and benefits.",
    retry: "Self-employed and benefits",
    intent: "known",
  },
  {
    id: "income_kind",
    text: "I work for myself right now, and I had a job before that I do not work at anymore.",
    retry: "Both — I work for myself now and had a job before",
    intent: "known",
  },
  {
    id: "self_employment_statements_offer",
    text: "I'm not sure yet.",
    retry: "Not sure yet",
    intent: "known",
  },
  {
    id: "prior_employer_current",
    text: "No, I do not work there anymore.",
    retry: "No, I do not work there anymore",
    intent: "known",
  },
  {
    id: "prior_employer_last_month",
    text: "I last got paid in June 2025.",
    retry: "June 2025",
    intent: "known",
    privateValue: "June 2025",
  },
  {
    id: "job_income_amount",
    text: "1200.",
    retry: "1200",
    intent: "known",
  },
  {
    id: "job_income_frequency",
    text: "Once a month.",
    retry: "Monthly",
    intent: "known",
  },
  {
    id: "benefits_income_amount",
    text: "I'm not sure.",
    retry: "I'm not sure",
    intent: "unknown",
  },
  {
    id: "benefits_income_frequency",
    text: "Once a month.",
    retry: "Monthly",
    intent: "known",
  },
  {
    id: "housing_status",
    text: "In a place I rent.",
    retry: "In a place I rent or own",
    intent: "known",
  },
  {
    id: "housing_cost",
    text: "1100 a month.",
    retry: "1100",
    intent: "known",
  },
  {
    id: "utilities_cost",
    text: "95.",
    retry: "95",
    intent: "known",
  },
  {
    id: "childcare_cost",
    text: "400.",
    retry: "400",
    intent: "known",
  },
  {
    id: "medical_cost",
    text: "I'm not sure.",
    retry: "I'm not sure",
    intent: "unknown",
  },
  {
    id: "id_status",
    text: "No, I need to get one.",
    retry: "I need to get one",
    intent: "known",
  },
  {
    id: "id_issue_detail",
    text: "I lost my ID when I moved.",
    retry: "I lost my ID when I moved",
    intent: "known",
    privateValue: "I lost my ID when I moved",
  },
  {
    id: "date_of_birth",
    text: "My date of birth is 1990-05-14.",
    retry: "1990-05-14",
    intent: "known",
    privateValue: "1990-05-14",
  },
  {
    id: "citizenship_status",
    text: "U.S. citizen.",
    retry: "U.S. citizen",
    intent: "known",
  },
  {
    id: "disability_status",
    text: "No.",
    retry: "No",
    intent: "known",
  },
  {
    id: "student_status",
    text: "I'm not in school.",
    retry: "No",
    intent: "known",
  },
  {
    id: "veteran_status",
    text: "No.",
    retry: "No",
    intent: "known",
  },
  {
    id: "received_benefits_before",
    text: "No.",
    retry: "No",
    intent: "known",
  },
  {
    id: "mailing_situation",
    text: "A shelter where I stay.",
    retry: "A shelter or program where I stay",
    intent: "known",
  },
  {
    id: "shelter_mail_consent",
    text: "Yes, the shelter agreed to hold my mail.",
    retry: "Yes",
    intent: "known",
  },
  {
    id: "contact_preference",
    text: "A phone call is best.",
    retry: "Phone call",
    intent: "known",
  },
  {
    id: "phone_contact",
    text: "My phone number is 555-0100.",
    retry: "555-0100",
    intent: "known",
    privateValue: "555-0100",
  },
  {
    id: "best_time_to_reach",
    text: "Mornings.",
    retry: "Morning",
    intent: "known",
  },
];

/**
 * The sample form's unmapped fields (no spec question behind them): their
 * answers ride the fill request and are never stored server-side. These
 * values are fictional demo data for the fictional persona.
 */
export const SAMPLE_FORM_UNMAPPED_ANSWERS = Object.freeze({
  applicant_name: "Jamie Watts",
  case_number: "SAMPLE-000000",
});
