# DSS-8207 field inventory (per page)

Generated from the committed template `dss-8207-fns-app-10-2024.pdf` by
`scripts/dss8207_field_inventory.py` (pypdf page-annotation walk).
Regenerate with `python3 scripts/dss8207_field_inventory.py` from
the repo root. Every AcroForm widget appears under its page with
its type, rectangle (x, y, width, height - PDF origin bottom-left),
read-only flag, checkbox/radio export values, choice options, any
pre-printed value, and the printed label evidence (the /TU tooltip
the form author wrote).

Counts: this walk sees
 601 widgets across 575 named fields. The app's
 discovery pass (discoverAcroFormFields, @cantoo/pdf-lib) walks only
 the five fillable kinds, so it sees
 600 widgets across 574 named fields -
 it skips the form's one digital-signature widget (page 8), which
 the registry entry carries as a not-collected field. The registry
 (kb/forms/dss-8207.json) covers every one of the named fields.

| page | widgets | named fields | types |
|---|---|---|---|
| 1 | 3 | 3 | checkbox 2, text 1 |
| 2 | 95 | 91 | checkbox 2, radio 8, text 85 |
| 3 | 89 | 85 | checkbox 38, radio 8, text 43 |
| 4 | 85 | 82 | checkbox 11, radio 6, text 68 |
| 5 | 102 | 98 | checkbox 22, radio 8, text 72 |
| 6 | 99 | 90 | checkbox 8, radio 16, text 75 |
| 7 | 95 | 94 | checkbox 8, radio 2, text 85 |
| 8 | 25 | 24 | checkbox 2, radio 2, signature 1, text 20 |
| 9 | 6 | 6 | text 6 |
| 10 | 2 | 2 | text 2 |

## Page 1

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `After the recorded` | text | 332, 637, 147, 12 |  |  |  | After the recorded |
| `Nutrition Services An Electronic Benefit Transfer Card EBT is a plastic card you use at the store to buy food  Do you` | checkbox | 487, 106, 11, 11 |  | Off, On |  | Nutrition Services. An Electronic Benefit Transfer Card (EBT) is a plastic card you use at the store to buy food.  Do you |
| `Yes` | checkbox | 523, 106, 11, 11 |  | Off, On |  | Yes |

## Page 2

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Expedited Benefits` | text | 121, 603, 482, 11 |  |  |  | Expedited Benefits |
| `AmountWhat is the households total countable monthly gross income` | text | 555, 569, 48, 11 |  |  |  | Amount_What is the household’s total countable monthly gross income? |
| `AmountWhat is the total household cash on hand or in a bank` | text | 555, 557, 48, 11 |  |  |  | Amount_What is the total household cash on hand/ or in a bank? |
| `AmountWhat are the total monthly shelter costs rent or mortgage that the household pays` | text | 555, 545, 48, 10 |  |  |  | Amount_What are the total monthly shelter costs (rent or mortgage) that the household pays? |
| `AmountWhat is the total monthly utility cost heat electricity LPNatural Gas WaterSewage GarbageTrash TelephoneCell Phone and Utility Excess Public Housing` | text | 555, 522, 48, 22 |  |  |  | Amount_What is the total monthly utility cost (heat, electricity, LP/Natural Gas, Water/Sewage, Garbage/Trash, Telephone/Cell Phone and Utility Excess (Public Housing). |
| `Yes_2` | checkbox | 291, 511, 10, 10 |  | Off, On |  | Yes |
| `No If Yes complete a  d If no go to next section` | checkbox | 329, 511, 10, 10 |  | Off, On |  | No If Yes, complete a – d If no, go to next section |
| `a Did hisher job end recently` | radio | 181, 499, 10, 10 |  | Off, Yes_3 |  | a. Did his/her job end recently |
| `a Did hisher job end recently` | radio | 214, 499, 10, 10 |  | No, Off |  | a. Did his/her job end recently |
| `b Did the only income received for the month of application end before today` | radio | 379, 488, 10, 10 |  | Off, Yes_4 |  | b. Did the only income received for the month of application end before today |
| `b Did the only income received for the month of application end before today` | radio | 413, 488, 10, 10 |  | No_2, Off |  | b. Did the only income received for the month of application end before today |
| `c Will heshe receive 25 or less from a new employer within 10 days` | radio | 346, 477, 10, 10 |  | Off, Yes_5 |  | c. Will he/she receive $25 or less from a new employer within 10 days |
| `c Will heshe receive 25 or less from a new employer within 10 days` | radio | 382, 477, 10, 10 |  | No_3, Off |  | c. Will he/she receive $25 or less from a new employer within 10 days |
| `d Will hisher liquid resources such as cash checkingsavings be 100 or less` | radio | 385, 465, 10, 10 |  | Off, Yes_6 |  | d. Will his/her liquid resources such as cash, checking/savings be $100 or less |
| `d Will hisher liquid resources such as cash checkingsavings be 100 or less` | radio | 418, 465, 10, 10 |  | No_4, Off |  | d. Will his/her liquid resources such as cash, checking/savings be $100 or less |
| `Tell Us About the People in your household` | text | 231, 437, 368, 11 |  |  |  | Tell Us About the People in your household. |
| `First Middle Initial  Last NameRow1` | text | 49, 314, 120, 22 |  |  |  | (First, Middle Initial, & Last Name)_Row_1 |
| `Birth DateSelf` | text | 229, 314, 37, 22 |  |  |  | Birth Date_Self |
| `AgeSexSelf` | text | 268, 314, 31, 22 |  |  |  | Age/Sex_Self |
| `Applying for Benefits YesNoSelf` | text | 301, 314, 46, 22 |  |  |  | Applying for Benefits? (Yes/No)_Self |
| `Optional Social Security Number see belowSelf` | text | 348, 314, 51, 22 |  |  |  | *Optional Social Security Number (see below)_Self |
| `Optional US Citizen YesNo see belowSelf` | text | 401, 314, 36, 22 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Self |
| `Optional Hispanic or Latino YesNo see belowSelf` | text | 439, 314, 36, 22 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Self |
| `Optional Race see belowSelf` | text | 476, 314, 52, 22 |  |  |  | **Optional Race (see below_Self |
| `Buy  Cook Together YesNoSelf` | text | 531, 314, 41, 22 |  |  |  | Buy & Cook Together Yes/No_Self |
| `First Middle Initial  Last NameRow2` | text | 49, 294, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_2 |
| `SelfRow1` | text | 171, 294, 57, 19 |  |  |  | Self_Row_1 |
| `Birth DateRow2` | text | 229, 294, 37, 19 |  |  |  | Birth Date_Row_2 |
| `AgeSexRow2` | text | 268, 294, 31, 19 |  |  |  | Age/Sex_Row_2 |
| `Applying for Benefits YesNoRow2` | text | 301, 294, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_2 |
| `Optional Social Security Number see belowRow2` | text | 348, 294, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_2 |
| `Optional US Citizen YesNo see belowRow2` | text | 401, 294, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_2 |
| `Optional Hispanic or Latino YesNo see belowRow2` | text | 439, 294, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_2 |
| `Optional Race see belowRow2` | text | 476, 294, 52, 19 |  |  |  | **Optional Race (see below_Row_2 |
| `Buy  Cook Together YesNoRow2` | text | 531, 294, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_2 |
| `First Middle Initial  Last NameRow3` | text | 49, 274, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_3 |
| `SelfRow2` | text | 171, 274, 57, 19 |  |  |  | Self_Row_2 |
| `Birth DateRow3` | text | 229, 274, 37, 19 |  |  |  | Birth Date_Row_3 |
| `AgeSexRow3` | text | 268, 274, 31, 19 |  |  |  | Age/Sex_Row_3 |
| `Applying for Benefits YesNoRow3` | text | 301, 274, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_3 |
| `Optional Social Security Number see belowRow3` | text | 348, 274, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_3 |
| `Optional US Citizen YesNo see belowRow3` | text | 401, 274, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_3 |
| `Optional Hispanic or Latino YesNo see belowRow3` | text | 439, 274, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_3 |
| `Optional Race see belowRow3` | text | 476, 274, 52, 19 |  |  |  | **Optional Race (see below_Row_3 |
| `Buy  Cook Together YesNoRow3` | text | 531, 274, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_3 |
| `First Middle Initial  Last NameRow4` | text | 49, 253, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_4 |
| `SelfRow3` | text | 171, 253, 57, 19 |  |  |  | Self_Row_3 |
| `Birth DateRow4` | text | 229, 253, 37, 19 |  |  |  | Birth Date_Row_4 |
| `AgeSexRow4` | text | 268, 253, 31, 19 |  |  |  | Age/Sex_Row_4 |
| `Applying for Benefits YesNoRow4` | text | 301, 253, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_4 |
| `Optional Social Security Number see belowRow4` | text | 348, 253, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_4 |
| `Optional US Citizen YesNo see belowRow4` | text | 401, 253, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_4 |
| `Optional Hispanic or Latino YesNo see belowRow4` | text | 439, 253, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_4 |
| `Optional Race see belowRow4` | text | 476, 253, 52, 19 |  |  |  | **Optional Race (see below_Row_4 |
| `Buy  Cook Together YesNoRow4` | text | 531, 253, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_4 |
| `First Middle Initial  Last NameRow5` | text | 49, 233, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_5 |
| `SelfRow4` | text | 171, 233, 57, 19 |  |  |  | Self_Row_4 |
| `Birth DateRow5` | text | 229, 233, 37, 19 |  |  |  | Birth Date_Row_5 |
| `AgeSexRow5` | text | 268, 233, 31, 19 |  |  |  | Age/Sex_Row_5 |
| `Applying for Benefits YesNoRow5` | text | 301, 233, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_5 |
| `Optional Social Security Number see belowRow5` | text | 348, 233, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_5 |
| `Optional US Citizen YesNo see belowRow5` | text | 401, 233, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_5 |
| `Optional Hispanic or Latino YesNo see belowRow5` | text | 439, 233, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_5 |
| `Optional Race see belowRow5` | text | 476, 233, 52, 19 |  |  |  | **Optional Race (see below_Row_5 |
| `Buy  Cook Together YesNoRow5` | text | 531, 233, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_5 |
| `First Middle Initial  Last NameRow6` | text | 49, 213, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_6 |
| `SelfRow5` | text | 171, 213, 57, 19 |  |  |  | Self_Row_5 |
| `Birth DateRow6` | text | 229, 213, 37, 19 |  |  |  | Birth Date_Row_6 |
| `AgeSexRow6` | text | 268, 213, 31, 19 |  |  |  | Age/Sex_Row_6 |
| `Applying for Benefits YesNoRow6` | text | 301, 213, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_6 |
| `Optional Social Security Number see belowRow6` | text | 348, 213, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_6 |
| `Optional US Citizen YesNo see belowRow6` | text | 401, 213, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_6 |
| `Optional Hispanic or Latino YesNo see belowRow6` | text | 439, 213, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_6 |
| `Optional Race see belowRow6` | text | 476, 213, 52, 19 |  |  |  | **Optional Race (see below_Row_6 |
| `Buy  Cook Together YesNoRow6` | text | 531, 213, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_6 |
| `First Middle Initial  Last NameRow7` | text | 49, 192, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_7 |
| `SelfRow6` | text | 171, 192, 57, 19 |  |  |  | Self_Row_6 |
| `Birth DateRow7` | text | 229, 192, 37, 19 |  |  |  | Birth Date_Row_7 |
| `AgeSexRow7` | text | 268, 192, 31, 19 |  |  |  | Age/Sex_Row_7 |
| `Applying for Benefits YesNoRow7` | text | 301, 192, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_7 |
| `Optional Social Security Number see belowRow7` | text | 348, 192, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_7 |
| `Optional US Citizen YesNo see belowRow7` | text | 401, 192, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_7 |
| `Optional Hispanic or Latino YesNo see belowRow7` | text | 439, 192, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_7 |
| `Optional Race see belowRow7` | text | 476, 192, 52, 19 |  |  |  | **Optional Race (see below_Row_7 |
| `Buy  Cook Together YesNoRow7` | text | 531, 192, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_7 |
| `First Middle Initial  Last NameRow8` | text | 49, 172, 120, 19 |  |  |  | (First, Middle Initial, & Last Name)_Row_8 |
| `SelfRow7` | text | 171, 172, 57, 19 |  |  |  | Self_Row_7 |
| `Birth DateRow8` | text | 229, 172, 37, 19 |  |  |  | Birth Date_Row_8 |
| `AgeSexRow8` | text | 268, 172, 31, 19 |  |  |  | Age/Sex_Row_8 |
| `Applying for Benefits YesNoRow8` | text | 301, 172, 46, 19 |  |  |  | Applying for Benefits? (Yes/No)_Row_8 |
| `Optional Social Security Number see belowRow8` | text | 348, 172, 51, 19 |  |  |  | *Optional Social Security Number (see below)_Row_8 |
| `Optional US Citizen YesNo see belowRow8` | text | 401, 172, 36, 19 |  |  |  | *Optional U.S. Citizen? (Yes/No) (see below)_Row_8 |
| `Optional Hispanic or Latino YesNo see belowRow8` | text | 439, 172, 36, 19 |  |  |  | *Optional Hispanic or Latino (Yes/No) (see below)_Row_8 |
| `Optional Race see belowRow8` | text | 476, 172, 52, 19 |  |  |  | **Optional Race (see below_Row_8 |
| `Buy  Cook Together YesNoRow8` | text | 531, 172, 41, 19 |  |  |  | Buy & Cook Together Yes/No_Row_8 |

## Page 3

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Are you a resident of this state` | radio | 183, 720, 10, 10 |  | Off, Yes_7 |  | Are you a resident of this state |
| `Are you a resident of this state` | radio | 214, 720, 10, 10 |  | No_5, Off |  | Are you a resident of this state |
| `Homeless which means that you lack a fixed and regular nighttime sleeping arrangement  WeI live in a` | checkbox | 37, 693, 10, 10 |  | Off, On |  | Homeless, which means that you lack a fixed and regular nighttime sleeping arrangement?  We/I live in a |
| `Home` | checkbox | 527, 693, 10, 10 |  | Off, On |  | Home |
| `Adult Care Home` | checkbox | 37, 676, 10, 10 |  | Off, On |  | Adult Care Home |
| `Alcohol andor Drug Treatment Center` | checkbox | 131, 676, 10, 10 |  | Off, On |  | Alcohol and/or Drug Treatment Center |
| `Group Home` | checkbox | 331, 676, 10, 10 |  | Off, On |  | Group Home |
| `Halfway House` | checkbox | 409, 676, 10, 10 |  | Off, On |  | Halfway House |
| `Hotel` | checkbox | 493, 676, 10, 10 |  | Off, On |  | Hotel |
| `Institution` | checkbox | 37, 658, 10, 10 |  | Off, On |  | Institution |
| `Residential Treatment Facility` | checkbox | 105, 658, 10, 10 |  | Off, On |  | Residential Treatment Facility |
| `Shelter for Battered Women and Children` | checkbox | 263, 658, 10, 10 |  | Off, On |  | Shelter for Battered Women and Children |
| `undefined` | checkbox | 478, 658, 10, 10 |  | Off, On |  | undefined |
| `Other` | text | 519, 659, 44, 11 |  |  |  | Other |
| `Yes_8` | checkbox | 326, 634, 12, 12 |  | Off, On |  | Yes |
| `No If no who buys separately` | checkbox | 360, 634, 12, 12 |  | Off, On |  | No If no, who buys separately |
| `Name of Separate Persons` | text | 166, 615, 300, 11 |  |  |  | Name of Separate Person(s |
| `Yes_9` | checkbox | 274, 594, 10, 10 |  | Off, On |  | Yes |
| `undefined_2` | checkbox | 309, 594, 10, 10 |  | Off, On |  | undefined |
| `No Who` | text | 367, 594, 83, 11 |  |  |  | No Who |
| `If yes what State issued this card` | text | 193, 578, 83, 11 |  |  |  | If yes, what State issued this card |
| `When was it last used` | text | 388, 578, 100, 11 |  |  |  | When was it last used |
| `Does anyone get Food and Nutrition Services Food Stamps or SNAP in this or another county or state` | radio | 507, 557, 10, 10 |  | Off, Yes_10 |  | Does anyone get Food and Nutrition Services, Food Stamps, or SNAP in this or another county or state |
| `Does anyone get Food and Nutrition Services Food Stamps or SNAP in this or another county or state` | radio | 542, 557, 10, 10 |  | No_6, Off |  | Does anyone get Food and Nutrition Services, Food Stamps, or SNAP in this or another county or state |
| `If yes who` | text | 92, 540, 167, 11 |  |  |  | If yes, who |
| `What County or State` | text | 363, 540, 167, 11 |  |  |  | What County or State |
| `When did the benefits start` | text | 160, 519, 53, 11 |  |  |  | When did the benefits start |
| `When did the benefits end` | text | 343, 519, 53, 11 |  |  |  | When did the benefits end |
| `Amount of benefits received` | text | 528, 519, 45, 11 |  |  |  | Amount of benefits received |
| `Does anyone participate in a Food Distribution Program on an Indian Reservation` | radio | 405, 498, 10, 10 |  | Off, Yes_11 |  | Does anyone participate in a Food Distribution Program on an Indian Reservation |
| `Does anyone participate in a Food Distribution Program on an Indian Reservation` | radio | 440, 498, 10, 10 |  | No_7, Off |  | Does anyone participate in a Food Distribution Program on an Indian Reservation |
| `Who` | text | 451, 458, 83, 11 |  |  |  | Who |
| `A veteran` | checkbox | 37, 458, 10, 10 |  | Off, On |  | A veteran |
| `A foster child` | checkbox | 37, 446, 10, 10 |  | Off, On |  | A foster child |
| `Individual who is 24 years of age or younger and in Foster Care under the responsibility of the State on their 18th` | checkbox | 37, 435, 10, 10 |  | Off, On |  | Individual who is 24 years of age or younger and in Foster Care under the responsibility of the State on their 18th |
| `undefined_3` | radio | 328, 446, 10, 10 |  | Off, Yes_12 |  | undefined |
| `undefined_3` | radio | 360, 446, 10, 10 |  | No_8, Off |  | undefined |
| `Who_2` | text | 451, 446, 83, 11 |  |  |  | Who |
| `Pregnant Due Date` | text | 150, 400, 89, 11 |  |  |  | Pregnant Due Date |
| `birthday` | checkbox | 37, 400, 10, 10 |  | Off, On |  | birthday |
| `In a drugalcohol treatment program` | checkbox | 37, 389, 10, 10 |  | Off, On |  | In a drug/alcohol treatment program |
| `A livein person attendant who takes care of someone in your household` | checkbox | 37, 377, 10, 10 |  | Off, On |  | A live-in person (attendant) who takes care of someone in your household |
| `Renting a room from you` | checkbox | 37, 366, 10, 10 |  | Off, On |  | Renting a room from you |
| `Paying for food and a place to stay` | checkbox | 37, 354, 10, 10 |  | Off, On |  | Paying for food and a place to stay |
| `Disqualified from Food and Nutrition Services in North Carolina or another state` | checkbox | 37, 343, 10, 10 |  | Off, On |  | Disqualified from Food and Nutrition Services in North Carolina or another state |
| `Trying to avoid a felony prosecution or fleeing from law enforcement` | checkbox | 37, 331, 10, 10 |  | Off, On |  | Trying to avoid a felony prosecution or fleeing from law enforcement |
| `Trying to avoid jail after conviction of a felony` | checkbox | 37, 320, 10, 10 |  | Off, On |  | Trying to avoid jail after conviction of a felony |
| `Violating conditions of probation or parole` | checkbox | 37, 308, 10, 10 |  | Off, On |  | Violating conditions of probation or parole |
| `undefined_4` | checkbox | 37, 297, 10, 10 |  | Off, On |  | undefined |
| `A person convicted of fraudulently receiving duplicate benefits` | checkbox | 37, 274, 10, 10 |  | Off, On |  | A person convicted of fraudulently receiving duplicate benefits |
| `A person convicted of trading benefits for guns drugs ammunitions or explosives` | checkbox | 37, 251, 10, 10 |  | Off, On |  | A person convicted of trading benefits for guns, drugs, ammunitions, or explosives |
| `A person convicted of buying or selling benefits over 500 or more` | checkbox | 37, 228, 10, 10 |  | Off, On |  | A person convicted of buying or selling benefits over $500 or more |
| `undefined_5` | checkbox | 37, 205, 10, 10 |  | Off, On |  | undefined |
| `In college or tradevocationaltechnical school at least halftime` | checkbox | 37, 159, 10, 10 |  | Off, On |  | In college or trade/vocational/technical school at least half-time |
| `Physically or mentally unfit for employment` | checkbox | 37, 136, 10, 10 |  | Off, On |  | Physically or mentally unfit for employment |
| `Operates a Home School at least 30 hours a week` | checkbox | 37, 124, 10, 10 |  | Off, On |  | Operates a Home School at least 30 hours a week |
| `Caring for an incapacitated person does not have to live in the home` | checkbox | 37, 113, 10, 10 |  | Off, On |  | Caring for an incapacitated person (does not have to live in the home |
| `Participates in an official Refugee Employment Program` | checkbox | 37, 101, 10, 10 |  | Off, On |  | Participates in an official Refugee Employment Program |
| `Unable to work due to alcohol andor drug addiction` | checkbox | 37, 90, 10, 10 |  | Off, On |  | Unable to work due to alcohol and/or drug addiction |
| `Who_3` | text | 454, 412, 83, 11 |  |  |  | Who |
| `Who_4` | text | 454, 400, 83, 11 |  |  |  | Who |
| `Who_5` | text | 454, 389, 83, 11 |  |  |  | Who |
| `Who_6` | text | 454, 377, 83, 11 |  |  |  | Who |
| `Who_7` | text | 454, 366, 83, 11 |  |  |  | Who |
| `Who_8` | text | 454, 354, 83, 11 |  |  |  | Who |
| `Who_9` | text | 451, 343, 83, 11 |  |  |  | Who |
| `Who_10` | text | 454, 331, 83, 11 |  |  |  | Who |
| `Who_11` | text | 454, 320, 83, 11 |  |  |  | Who |
| `Who_12` | text | 454, 308, 83, 11 |  |  |  | Who |
| `A person convicted of a drug related felony or controlled substance committed after Who` | text | 454, 297, 83, 11 |  |  |  | A person convicted of a drug related felony or controlled substance committed after Who |
| `August 22 1996 If convicted what state` | text | 233, 285, 56, 11 |  |  |  | August 22, 1996. If convicted what state |
| `date of conviction` | text | 369, 285, 56, 11 |  |  |  | date of conviction |
| `Who_13` | text | 456, 274, 83, 11 |  |  |  | Who |
| `in any State after August 22 1996 If convicted what state` | text | 314, 262, 56, 11 |  |  |  | in any State after August 22, 1996. If convicted what state |
| `date of conviction_2` | text | 447, 262, 56, 11 |  |  |  | date of conviction |
| `Who_14` | text | 456, 251, 83, 11 |  |  |  | Who |
| `after August 22 1996 If convicted what state` | text | 253, 239, 56, 11 |  |  |  | after August 22, 1996. If convicted what state |
| `date of conviction_3` | text | 389, 239, 55, 11 |  |  |  | date of conviction |
| `Who_15` | text | 462, 228, 83, 11 |  |  |  | Who |
| `after August 22 1996 If convicted what state_2` | text | 253, 216, 56, 11 |  |  |  | after August 22, 1996. If convicted what state |
| `Have you or any member of your household been convicted as an adult of aggravated Who` | text | 465, 205, 83, 11 |  |  |  | Have you or any member of your household been convicted as an adult of aggravated Who |
| `date of conviction_4` | text | 389, 216, 56, 11 |  |  |  | date of conviction |
| `Who_16` | text | 465, 159, 83, 11 |  |  |  | Who |
| `Name of School` | text | 143, 147, 89, 11 |  |  |  | Name of School |
| `Who_17` | text | 465, 136, 83, 11 |  |  |  | Who |
| `Who_18` | text | 465, 124, 83, 11 |  |  |  | Who |
| `Who_19` | text | 466, 113, 83, 11 |  |  |  | Who |
| `Who_20` | text | 468, 101, 84, 11 |  |  |  | Who |
| `Who_21` | text | 468, 90, 84, 11 |  |  |  | Who |

## Page 4

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Does your household own any of the assets listed below` | radio | 37, 684, 9, 9 |  | Off, Yes_13 |  | Does your household own any of the assets listed below |
| `Does your household own any of the assets listed below` | radio | 69, 684, 9, 9 |  | No_9, Off |  | Does your household own any of the assets listed below |
| `Please check all the assets you own someone else in your household owns or jointly own with nonhousehold member` | radio | 284, 667, 9, 9 |  | Off, Yes_14 |  | Please check all the assets you own, someone else in your household owns, or jointly own with non-household member |
| `Please check all the assets you own someone else in your household owns or jointly own with nonhousehold member` | radio | 316, 667, 9, 9 |  | No_10, Off |  | Please check all the assets you own, someone else in your household owns, or jointly own with non-household member |
| `Cash` | checkbox | 44, 601, 9, 9 |  | Off, On |  | Cash |
| `Who Does This Belong ToCash` | text | 206, 600, 151, 21 |  |  |  | Who Does This Belong To?_Cash |
| `Value or WorthCash` | text | 359, 600, 79, 21 |  |  |  | Value or Worth_Cash |
| `Business Name and Account NumberCash` | text | 440, 600, 142, 21 |  |  |  | Business Name and Account Number_Cash |
| `Checking andor Savings Acct` | checkbox | 44, 579, 9, 9 |  | Off, On |  | Checking and/or Savings Acct |
| `Who Does This Belong ToChecking andor Savings Acct` | text | 206, 578, 151, 21 |  |  |  | Who Does This Belong To?_Checking and/or Savings Acct |
| `Value or WorthChecking andor Savings Acct` | text | 359, 578, 79, 21 |  |  |  | Value or Worth_Checking and/or Savings Acct |
| `Business Name and Account NumberChecking andor Savings Acct` | text | 440, 578, 142, 21 |  |  |  | Business Name and Account Number_Checking and/or Savings Acct |
| `Retirement Accounts` | checkbox | 44, 557, 9, 9 |  | Off, On |  | Retirement Accounts |
| `Who Does This Belong ToRetirement Accounts` | text | 206, 556, 151, 21 |  |  |  | Who Does This Belong To?_Retirement Accounts |
| `Value or WorthRetirement Accounts` | text | 359, 556, 79, 21 |  |  |  | Value or Worth_Retirement Accounts |
| `Business Name and Account NumberRetirement Accounts` | text | 440, 556, 142, 21 |  |  |  | Business Name and Account Number_Retirement Accounts |
| `Mutual Funds or Trust Funds` | checkbox | 44, 534, 9, 9 |  | Off, On |  | Mutual Funds or Trust Funds |
| `Who Does This Belong ToMutual Funds or Trust Funds` | text | 206, 533, 151, 21 |  |  |  | Who Does This Belong To?_Mutual Funds or Trust Funds |
| `Value or WorthMutual Funds or Trust Funds` | text | 359, 533, 79, 21 |  |  |  | Value or Worth_Mutual Funds or Trust Funds |
| `Business Name and Account NumberMutual Funds or Trust Funds` | text | 440, 533, 142, 21 |  |  |  | Business Name and Account Number_Mutual Funds or Trust Funds |
| `Prepaid Burial Contracts` | checkbox | 44, 512, 9, 9 |  | Off, On |  | Prepaid Burial Contracts |
| `Who Does This Belong ToPrepaid Burial Contracts` | text | 206, 511, 151, 21 |  |  |  | Who Does This Belong To?_Prepaid Burial Contracts |
| `Value or WorthPrepaid Burial Contracts` | text | 359, 511, 79, 21 |  |  |  | Value or Worth_Prepaid Burial Contracts |
| `Business Name and Account NumberPrepaid Burial Contracts` | text | 440, 511, 142, 21 |  |  |  | Business Name and Account Number_Prepaid Burial Contracts |
| `Certificates of Deposit CDs` | checkbox | 44, 490, 9, 9 |  | Off, On |  | Certificates of Deposit (CD’s |
| `Who Does This Belong ToCertificates of Deposit CDs` | text | 206, 489, 151, 21 |  |  |  | Who Does This Belong To?_Certificates of Deposit (CD’s) |
| `Value or WorthCertificates of Deposit CDs` | text | 359, 489, 79, 21 |  |  |  | Value or Worth_Certificates of Deposit (CD’s) |
| `Business Name and Account NumberCertificates of Deposit CDs` | text | 440, 489, 142, 21 |  |  |  | Business Name and Account Number_Certificates of Deposit (CD’s) |
| `Stocks or Bonds` | checkbox | 44, 467, 9, 9 |  | Off, On |  | Stocks or Bonds |
| `Who Does This Belong ToStocks or Bonds` | text | 206, 466, 151, 21 |  |  |  | Who Does This Belong To?_Stocks or Bonds |
| `Value or WorthStocks or Bonds` | text | 359, 466, 79, 21 |  |  |  | Value or Worth_Stocks or Bonds |
| `Business Name and Account NumberStocks or Bonds` | text | 440, 466, 142, 21 |  |  |  | Business Name and Account Number_Stocks or Bonds |
| `LotteryGambling Winnings` | checkbox | 44, 446, 9, 9 |  | Off, On |  | Lottery/Gambling Winnings |
| `Who Does This Belong ToLotteryGambling Winnings` | text | 206, 445, 151, 20 |  |  |  | Who Does This Belong To?_Lottery/Gambling Winnings |
| `Value or WorthLotteryGambling Winnings` | text | 359, 445, 79, 20 |  |  |  | Value or Worth_Lottery/Gambling Winnings |
| `Business Name and Account NumberLotteryGambling Winnings` | text | 440, 445, 142, 20 |  |  |  | Business Name and Account Number_Lottery/Gambling Winnings |
| `Other Assets Not Listed such as` | checkbox | 44, 424, 9, 9 |  | Off, On |  | Other Assets Not Listed (such as |
| `Who Does This Belong ToOther Assets Not Listed such as interest income` | text | 207, 413, 151, 30 |  |  |  | Who Does This Belong To?_Other Assets Not Listed (such as interest income) |
| `Value or WorthOther Assets Not Listed such as interest income` | text | 360, 413, 79, 30 |  |  |  | Value or Worth_Other Assets Not Listed (such as interest income) |
| `Business Name and Account NumberOther Assets Not Listed such as interest income` | text | 441, 413, 142, 30 |  |  |  | Business Name and Account Number_Other Assets Not Listed (such as interest income) |
| `Please provide proof of all income received from the last 30 days` | radio | 224, 378, 10, 10 |  | Off, Yes_15 |  | Please provide proof of all income received from the last 30 days |
| `Please provide proof of all income received from the last 30 days` | radio | 258, 378, 10, 10 |  | No_11, Off |  | Please provide proof of all income received from the last 30 days |
| `NameRow1` | text | 37, 254, 103, 22 |  |  |  | Name_Row_1 |
| `Employer Name Address Phone Number if AvailableRow1` | text | 142, 254, 102, 22 |  |  |  | Employer (Name, Address, Phone Number if Available)_Row_1 |
| `Start DateRow1` | text | 245, 254, 43, 22 |  |  |  | Start Date_Row_1 |
| `Gross Pay Pay Before TaxesRow1` | text | 290, 254, 52, 22 |  |  |  | Gross Pay (Pay Before Taxes)_Row_1 |
| `How Often is Pay ReceivedRow1` | text | 344, 254, 57, 22 |  |  |  | How Often is Pay Received?_Row_1 |
| `Last date Pay ReceivedRow1` | text | 403, 254, 52, 22 |  |  |  | Last date Pay Received_Row_1 |
| `Day of Week Pay ReceivedRow1` | text | 457, 254, 52, 22 |  |  |  | Day of Week Pay Received_Row_1 |
| `Hours Per WeekRow1` | text | 511, 254, 39, 22 |  |  |  | Hours Per Week_Row_1 |
| `Days Worked Per WeekRow1` | text | 551, 254, 43, 22 |  |  |  | Days Worked Per Week_Row_1 |
| `NameRow2` | text | 37, 230, 103, 22 |  |  |  | Name_Row_2 |
| `Employer Name Address Phone Number if AvailableRow2` | text | 142, 230, 102, 22 |  |  |  | Employer (Name, Address, Phone Number if Available)_Row_2 |
| `Start DateRow2` | text | 245, 230, 43, 22 |  |  |  | Start Date_Row_2 |
| `Gross Pay Pay Before TaxesRow2` | text | 290, 230, 52, 22 |  |  |  | Gross Pay (Pay Before Taxes)_Row_2 |
| `How Often is Pay ReceivedRow2` | text | 344, 230, 57, 22 |  |  |  | How Often is Pay Received?_Row_2 |
| `Last date Pay ReceivedRow2` | text | 403, 230, 52, 22 |  |  |  | Last date Pay Received_Row_2 |
| `Day of Week Pay ReceivedRow2` | text | 457, 230, 52, 22 |  |  |  | Day of Week Pay Received_Row_2 |
| `Hours Per WeekRow2` | text | 511, 230, 39, 22 |  |  |  | Hours Per Week_Row_2 |
| `Days Worked Per WeekRow2` | text | 551, 230, 43, 22 |  |  |  | Days Worked Per Week_Row_2 |
| `NameRow3` | text | 37, 207, 103, 22 |  |  |  | Name_Row_3 |
| `Employer Name Address Phone Number if AvailableRow3` | text | 142, 207, 102, 22 |  |  |  | Employer (Name, Address, Phone Number if Available)_Row_3 |
| `Start DateRow3` | text | 245, 207, 43, 22 |  |  |  | Start Date_Row_3 |
| `Gross Pay Pay Before TaxesRow3` | text | 290, 207, 52, 22 |  |  |  | Gross Pay (Pay Before Taxes)_Row_3 |
| `How Often is Pay ReceivedRow3` | text | 344, 207, 57, 22 |  |  |  | How Often is Pay Received?_Row_3 |
| `Last date Pay ReceivedRow3` | text | 403, 207, 52, 22 |  |  |  | Last date Pay Received_Row_3 |
| `Day of Week Pay ReceivedRow3` | text | 457, 207, 52, 22 |  |  |  | Day of Week Pay Received_Row_3 |
| `Hours Per WeekRow3` | text | 511, 207, 39, 22 |  |  |  | Hours Per Week_Row_3 |
| `Days Worked Per WeekRow3` | text | 551, 207, 43, 22 |  |  |  | Days Worked Per Week_Row_3 |
| `Yes_16` | checkbox | 250, 193, 12, 12 |  | Off, On |  | Yes |
| `No If yes complete below` | checkbox | 286, 193, 12, 12 |  | Off, On |  | No If yes, complete below |
| `NameRow1_2` | text | 37, 107, 85, 16 |  |  |  | Name_Row_1 |
| `Start DateRow1_2` | text | 123, 107, 58, 16 |  |  |  | Start Date_Row_1 |
| `Business NameRow1` | text | 183, 107, 93, 16 |  |  |  | Business Name_Row_1 |
| `Type of BusinessRow1` | text | 278, 107, 96, 16 |  |  |  | Type of Business_Row_1 |
| `Hours Per WeekRow1_2` | text | 375, 107, 70, 16 |  |  |  | ***Hours Per Week_Row_1 |
| `Gross Monthly IncomeRow1` | text | 447, 107, 84, 16 |  |  |  | Gross Monthly Income_Row_1 |
| `Monthly ExpensesRow1` | text | 533, 107, 57, 16 |  |  |  | Monthly Expenses_Row_1 |
| `NameRow2_2` | text | 37, 89, 85, 16 |  |  |  | Name_Row_2 |
| `Start DateRow2_2` | text | 123, 89, 58, 16 |  |  |  | Start Date_Row_2 |
| `Business NameRow2` | text | 183, 89, 93, 16 |  |  |  | Business Name_Row_2 |
| `Type of BusinessRow2` | text | 278, 89, 96, 16 |  |  |  | Type of Business_Row_2 |
| `Hours Per WeekRow2_2` | text | 375, 89, 70, 16 |  |  |  | ***Hours Per Week_Row_2 |
| `Gross Monthly IncomeRow2` | text | 447, 89, 84, 16 |  |  |  | Gross Monthly Income_Row_2 |
| `Monthly ExpensesRow2` | text | 533, 89, 57, 16 |  |  |  | Monthly Expenses_Row_2 |

## Page 5

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Yes_17` | checkbox | 231, 731, 12, 12 |  | Off, On |  | Yes |
| `No If yes complete below_2` | checkbox | 270, 731, 12, 12 |  | Off, On |  | No If yes, complete below |
| `NameRow1_3` | text | 36, 645, 88, 22 |  |  |  | Name_Row_1 |
| `Employer Name Address Phone Number If AvailableRow1` | text | 126, 645, 129, 22 |  |  |  | Employer (Name, Address, Phone Number If Available)_Row_1 |
| `Start DateRow1_3` | text | 257, 645, 34, 22 |  |  |  | Start Date_Row_1 |
| `Gross Pay Pay Before TaxesRow1_2` | text | 293, 645, 43, 22 |  |  |  | Gross Pay (Pay Before Taxes)_Row_1 |
| `How Often is Pay ReceivedRow1_2` | text | 338, 645, 57, 22 |  |  |  | How Often is Pay Received?_Row_1 |
| `Date of First Pay ReceivedRow1` | text | 396, 645, 52, 22 |  |  |  | Date of First Pay Received_Row_1 |
| `Day of the Week Pay ReceivedRow1` | text | 450, 645, 52, 22 |  |  |  | Day of the Week Pay Received_Row_1 |
| `Hours Per WeekRow1_3` | text | 504, 645, 34, 22 |  |  |  | Hours Per Week_Row_1 |
| `Days Worked Per WeekRow1_2` | text | 540, 645, 43, 22 |  |  |  | Days Worked Per Week_Row_1 |
| `NameRow2_3` | text | 36, 622, 88, 22 |  |  |  | Name_Row_2 |
| `Employer Name Address Phone Number If AvailableRow2` | text | 126, 622, 129, 22 |  |  |  | Employer (Name, Address, Phone Number If Available)_Row_2 |
| `Start DateRow2_3` | text | 257, 622, 34, 22 |  |  |  | Start Date_Row_2 |
| `Gross Pay Pay Before TaxesRow2_2` | text | 293, 622, 43, 22 |  |  |  | Gross Pay (Pay Before Taxes)_Row_2 |
| `How Often is Pay ReceivedRow2_2` | text | 338, 622, 57, 22 |  |  |  | How Often is Pay Received?_Row_2 |
| `Date of First Pay ReceivedRow2` | text | 396, 622, 52, 22 |  |  |  | Date of First Pay Received_Row_2 |
| `Day of the Week Pay ReceivedRow2` | text | 450, 622, 52, 22 |  |  |  | Day of the Week Pay Received_Row_2 |
| `Hours Per WeekRow2_3` | text | 504, 622, 34, 22 |  |  |  | Hours Per Week_Row_2 |
| `Days Worked Per WeekRow2_2` | text | 540, 622, 43, 22 |  |  |  | Days Worked Per Week_Row_2 |
| `NameRow3_2` | text | 36, 598, 88, 22 |  |  |  | Name_Row_3 |
| `Employer Name Address Phone Number If AvailableRow3` | text | 126, 598, 129, 22 |  |  |  | Employer (Name, Address, Phone Number If Available)_Row_3 |
| `Start DateRow3_2` | text | 257, 598, 34, 22 |  |  |  | Start Date_Row_3 |
| `Gross Pay Pay Before TaxesRow3_2` | text | 293, 598, 43, 22 |  |  |  | Gross Pay (Pay Before Taxes)_Row_3 |
| `How Often is Pay ReceivedRow3_2` | text | 338, 598, 57, 22 |  |  |  | How Often is Pay Received?_Row_3 |
| `Date of First Pay ReceivedRow3` | text | 396, 598, 52, 22 |  |  |  | Date of First Pay Received_Row_3 |
| `Day of the Week Pay ReceivedRow3` | text | 450, 598, 52, 22 |  |  |  | Day of the Week Pay Received_Row_3 |
| `Hours Per WeekRow3_2` | text | 504, 598, 34, 22 |  |  |  | Hours Per Week_Row_3 |
| `Days Worked Per WeekRow3_2` | text | 540, 598, 43, 22 |  |  |  | Days Worked Per Week_Row_3 |
| `Has anyone stopped working in the past 30 days` | radio | 275, 573, 12, 12 |  | Off, Yes_18 |  | Has anyone stopped working in the past 30 days |
| `Has anyone stopped working in the past 30 days` | radio | 315, 573, 12, 12 |  | No_12, Off |  | Has anyone stopped working in the past 30 days |
| `NameRow1_4` | text | 37, 508, 89, 17 |  |  |  | Name_Row_1 |
| `Employer Name Address Phone Number if AvailableRow1_2` | text | 128, 508, 124, 17 |  |  |  | Employer (Name, Address, Phone Number if Available)_Row_1 |
| `End DateRow1` | text | 254, 508, 52, 17 |  |  |  | End Date_Row_1 |
| `Date Last Pay Received or Will Be ReceivedRow1` | text | 308, 508, 84, 17 |  |  |  | Date Last Pay Received or Will Be Received_Row_1 |
| `Gross Amount of Last PayRow1` | text | 393, 508, 70, 17 |  |  |  | Gross Amount of Last Pay_Row_1 |
| `Total Hours Worked in Past 30 DaysRow1` | text | 465, 508, 66, 17 |  |  |  | Total Hours Worked in Past 30 Days_Row_1 |
| `Reason Stopped WorkingRow1` | text | 533, 508, 53, 17 |  |  |  | Reason Stopped Working_Row_1 |
| `NameRow2_4` | text | 37, 490, 89, 17 |  |  |  | Name_Row_2 |
| `Employer Name Address Phone Number if AvailableRow2_2` | text | 128, 490, 124, 17 |  |  |  | Employer (Name, Address, Phone Number if Available)_Row_2 |
| `End DateRow2` | text | 254, 490, 52, 17 |  |  |  | End Date_Row_2 |
| `Date Last Pay Received or Will Be ReceivedRow2` | text | 308, 490, 84, 17 |  |  |  | Date Last Pay Received or Will Be Received_Row_2 |
| `Gross Amount of Last PayRow2` | text | 393, 490, 70, 17 |  |  |  | Gross Amount of Last Pay_Row_2 |
| `Total Hours Worked in Past 30 DaysRow2` | text | 465, 490, 66, 17 |  |  |  | Total Hours Worked in Past 30 Days_Row_2 |
| `Reason Stopped WorkingRow2` | text | 533, 490, 53, 17 |  |  |  | Reason Stopped Working_Row_2 |
| `NameRow3_3` | text | 37, 472, 89, 17 |  |  |  | Name_Row_3 |
| `Employer Name Address Phone Number if AvailableRow3_2` | text | 128, 472, 124, 17 |  |  |  | Employer (Name, Address, Phone Number if Available)_Row_3 |
| `End DateRow3` | text | 254, 472, 52, 17 |  |  |  | End Date_Row_3 |
| `Date Last Pay Received or Will Be ReceivedRow3` | text | 308, 472, 84, 17 |  |  |  | Date Last Pay Received or Will Be Received_Row_3 |
| `Gross Amount of Last PayRow3` | text | 393, 472, 70, 17 |  |  |  | Gross Amount of Last Pay_Row_3 |
| `Total Hours Worked in Past 30 DaysRow3` | text | 465, 472, 66, 17 |  |  |  | Total Hours Worked in Past 30 Days_Row_3 |
| `Reason Stopped WorkingRow3` | text | 533, 472, 53, 17 |  |  |  | Reason Stopped Working_Row_3 |
| `Is anyone a migrant or seasonal farm worker` | radio | 246, 458, 12, 12 |  | Off, Yes_19 |  | Is anyone a migrant or seasonal farm worker |
| `Is anyone a migrant or seasonal farm worker` | radio | 285, 458, 12, 12 |  | No_13, Off |  | Is anyone a migrant or seasonal farm worker |
| `Date started working` | text | 133, 447, 392, 11 |  |  |  | Date started working |
| `Place working  phone number` | text | 183, 436, 342, 11 |  |  |  | Place working & phone number |
| `Is anyone on strike` | radio | 132, 422, 12, 12 |  | Off, Yes_20 |  | Is anyone on strike |
| `Is anyone on strike` | radio | 171, 422, 12, 12 |  | No_14, Off |  | Is anyone on strike |
| `If yes who_2` | text | 261, 422, 264, 11 |  |  |  | If yes, who |
| `Last date worked` | text | 120, 410, 75, 11 |  |  |  | Last date worked |
| `Place worked  phone number` | text | 338, 410, 186, 11 |  |  |  | Place worked & phone number |
| `Does anyone work as a volunteer or participate in a work training program` | radio | 387, 376, 10, 10 |  | Off, Yes_21 |  | Does anyone work as a volunteer or participate in a work training program |
| `Does anyone work as a volunteer or participate in a work training program` | radio | 421, 376, 10, 10 |  | No_15, Off |  | Does anyone work as a volunteer or participate in a work training program |
| `NameRow1_5` | text | 37, 304, 125, 17 |  |  |  | Name_Row_1 |
| `Name of Volunteer Site or Work Training ProgramRow1` | text | 164, 304, 120, 17 |  |  |  | Name of Volunteer Site or Work Training Program_Row_1 |
| `Site Address and Phone Number if AvailableRow1` | text | 285, 304, 183, 17 |  |  |  | Site Address and Phone Number (if Available)_Row_1 |
| `Start DateRow1_4` | text | 470, 304, 34, 17 |  |  |  | Start Date_Row_1 |
| `End DateRow1_2` | text | 506, 304, 34, 17 |  |  |  | End Date_Row_1 |
| `Hours Per WeekRow1_4` | text | 542, 304, 43, 17 |  |  |  | Hours Per Week_Row_1 |
| `NameRow2_5` | text | 37, 286, 125, 17 |  |  |  | Name_Row_2 |
| `Name of Volunteer Site or Work Training ProgramRow2` | text | 164, 286, 120, 17 |  |  |  | Name of Volunteer Site or Work Training Program_Row_2 |
| `Site Address and Phone Number if AvailableRow2` | text | 285, 286, 183, 17 |  |  |  | Site Address and Phone Number (if Available)_Row_2 |
| `Start DateRow2_4` | text | 470, 286, 34, 17 |  |  |  | Start Date_Row_2 |
| `End DateRow2_2` | text | 506, 286, 34, 17 |  |  |  | End Date_Row_2 |
| `Hours Per WeekRow2_4` | text | 542, 286, 43, 17 |  |  |  | Hours Per Week_Row_2 |
| `NameRow3_4` | text | 37, 268, 125, 17 |  |  |  | Name_Row_3 |
| `Name of Volunteer Site or Work Training ProgramRow3` | text | 164, 268, 120, 17 |  |  |  | Name of Volunteer Site or Work Training Program_Row_3 |
| `Site Address and Phone Number if AvailableRow3` | text | 285, 268, 183, 17 |  |  |  | Site Address and Phone Number (if Available)_Row_3 |
| `Start DateRow3_3` | text | 470, 268, 34, 17 |  |  |  | Start Date_Row_3 |
| `End DateRow3_2` | text | 506, 268, 34, 17 |  |  |  | End Date_Row_3 |
| `Hours Per WeekRow3_3` | text | 542, 268, 43, 17 |  |  |  | Hours Per Week_Row_3 |
| `Social Security` | checkbox | 354, 191, 9, 9 |  | Off, On |  | Social Security |
| `Special Assistance SA` | checkbox | 354, 180, 9, 9 |  | Off, On |  | Special Assistance (SA |
| `Supplemental Security Income SSI` | checkbox | 354, 169, 9, 9 |  | Off, On |  | Supplemental Security Income (SSI |
| `Unemployment Benefits` | checkbox | 354, 159, 9, 9 |  | Off, On |  | Unemployment Benefits |
| `Veterans Benefits` | checkbox | 354, 147, 9, 9 |  | Off, On |  | Veterans Benefits |
| `Work FirstTANF` | checkbox | 354, 137, 9, 9 |  | Off, On |  | Work First/TANF |
| `Interest and Dividends` | checkbox | 354, 126, 9, 9 |  | Off, On |  | Interest and Dividends |
| `Workers Compensation` | checkbox | 354, 115, 9, 9 |  | Off, On |  | Workers Compensation |
| `Other_2` | checkbox | 354, 104, 9, 9 |  | Off, On |  | Other |
| `My Household does not get any other money` | checkbox | 354, 93, 9, 9 |  | Off, On |  | My Household does not get any other money |
| `Adoption Foster Care or Guardianship Payments` | checkbox | 39, 191, 9, 9 |  | Off, On |  | Adoption, Foster Care, or Guardianship Payments |
| `Annuities Pensions or Retirement` | checkbox | 39, 180, 9, 9 |  | Off, On |  | Annuities, Pensions, or Retirement |
| `Alimony` | checkbox | 39, 169, 9, 9 |  | Off, On |  | Alimony |
| `Child Support from parent or` | checkbox | 39, 159, 9, 9 |  | Off, On |  | Child Support from parent or |
| `Educational Scholarships` | checkbox | 39, 147, 9, 9 |  | Off, On |  | Educational Scholarships |
| `Military Allotment` | checkbox | 39, 137, 9, 9 |  | Off, On |  | Military Allotment |
| `Money from friends or relatives that is not a loan and you dont have` | checkbox | 39, 126, 9, 9 |  | Off, On |  | Money from friends or relatives that is not a loan and you don’t have |
| `Payments for the sale of an asset such as a car boat mobile home` | checkbox | 39, 104, 9, 9 |  | Off, On |  | Payments for the sale of an asset (such as a car, boat, mobile home |
| `Private Disability` | checkbox | 39, 82, 9, 9 |  | Off, On |  | Private Disability |
| `Child Support from the Court` | checkbox | 178, 159, 9, 9 |  | Off, On |  | Child Support from the Court |
| `undefined_6` | text | 395, 104, 85, 10 |  |  |  | undefined |

## Page 6

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Type of MoneyRow1` | text | 37, 677, 48, 12 |  |  |  | Type of Money_Row_1 |
| `Who Gets the MoneyRow1` | text | 87, 677, 80, 12 |  |  |  | Who Gets the Money?_Row_1 |
| `Who Gives the MoneyRow1` | text | 168, 677, 84, 12 |  |  |  | Who Gives the Money?_Row_1 |
| `Phone Number and Address of PersonOrganization That Gives You MoneyRow1` | text | 253, 677, 192, 12 |  |  |  | Phone Number and Address of Person/Organization That Gives You Money_Row_1 |
| `How MuchRow1` | text | 447, 677, 44, 12 |  |  |  | How Much?_Row_1 |
| `How OftenRow1` | text | 492, 677, 42, 12 |  |  |  | How Often?_Row_1 |
| `Date Last ReceivedRow1` | text | 535, 677, 56, 12 |  |  |  | Date Last Received_Row_1 |
| `Type of MoneyRow2` | text | 37, 663, 48, 12 |  |  |  | Type of Money_Row_2 |
| `Who Gets the MoneyRow2` | text | 87, 663, 80, 12 |  |  |  | Who Gets the Money?_Row_2 |
| `Who Gives the MoneyRow2` | text | 168, 663, 84, 12 |  |  |  | Who Gives the Money?_Row_2 |
| `Phone Number and Address of PersonOrganization That Gives You MoneyRow2` | text | 253, 663, 192, 12 |  |  |  | Phone Number and Address of Person/Organization That Gives You Money_Row_2 |
| `How MuchRow2` | text | 447, 663, 44, 12 |  |  |  | How Much?_Row_2 |
| `How OftenRow2` | text | 492, 663, 42, 12 |  |  |  | How Often?_Row_2 |
| `Date Last ReceivedRow2` | text | 535, 663, 56, 12 |  |  |  | Date Last Received_Row_2 |
| `Type of MoneyRow3` | text | 37, 651, 48, 11 |  |  |  | Type of Money_Row_3 |
| `Who Gets the MoneyRow3` | text | 86, 651, 80, 11 |  |  |  | Who Gets the Money?_Row_3 |
| `Who Gives the MoneyRow3` | text | 167, 651, 84, 11 |  |  |  | Who Gives the Money?_Row_3 |
| `Phone Number and Address of PersonOrganization That Gives You MoneyRow3` | text | 253, 651, 192, 11 |  |  |  | Phone Number and Address of Person/Organization That Gives You Money_Row_3 |
| `How MuchRow3` | text | 446, 651, 44, 11 |  |  |  | How Much?_Row_3 |
| `How OftenRow3` | text | 491, 651, 42, 11 |  |  |  | How Often?_Row_3 |
| `Date Last ReceivedRow3` | text | 535, 651, 56, 11 |  |  |  | Date Last Received_Row_3 |
| `Type of MoneyRow4` | text | 37, 639, 48, 11 |  |  |  | Type of Money_Row_4 |
| `Who Gets the MoneyRow4` | text | 86, 639, 80, 11 |  |  |  | Who Gets the Money?_Row_4 |
| `Who Gives the MoneyRow4` | text | 167, 639, 84, 11 |  |  |  | Who Gives the Money?_Row_4 |
| `Phone Number and Address of PersonOrganization That Gives You MoneyRow4` | text | 253, 639, 192, 11 |  |  |  | Phone Number and Address of Person/Organization That Gives You Money_Row_4 |
| `How MuchRow4` | text | 446, 639, 44, 11 |  |  |  | How Much?_Row_4 |
| `How OftenRow4` | text | 491, 639, 42, 11 |  |  |  | How Often?_Row_4 |
| `Date Last ReceivedRow4` | text | 535, 639, 56, 11 |  |  |  | Date Last Received_Row_4 |
| `Is any of the income listed above child support` | radio | 250, 623, 9, 9 |  | Off, Yes_22 |  | Is any of the income listed above child support |
| `Is any of the income listed above child support` | radio | 284, 623, 9, 9 |  | No If yes is the child support court ordered, Off |  | Is any of the income listed above child support |
| `Is any of the income listed above child support` | radio | 497, 623, 9, 9 |  | Off, Yes_23 |  | Is any of the income listed above child support |
| `Is any of the income listed above child support` | radio | 530, 623, 9, 9 |  | No_16, Off |  | Is any of the income listed above child support |
| `If yes what is the Court Order Number` | text | 210, 611, 61, 11 |  |  |  | If yes, what is the Court Order Number |
| `Date Established` | text | 352, 611, 61, 11 |  |  |  | Date Established |
| `Obligated Amount` | text | 499, 611, 45, 11 |  |  |  | Obligated Amount |
| `Name Address Phone Number to Whom You Pay the BillRent or Mortgage` | text | 178, 494, 187, 23 |  |  |  | Name, Address, Phone Number to Whom You Pay the Bill_Rent or Mortgage |
| `Amount BilledRent or Mortgage` | text | 367, 494, 75, 23 |  |  |  | Amount Billed_Rent or Mortgage |
| `How Often PaidRent or Mortgage` | text | 443, 494, 56, 23 |  |  |  | How Often Paid?_Rent or Mortgage |
| `Who Pays the BillRent or Mortgage` | text | 502, 494, 88, 23 |  |  |  | Who Pays the Bill?_Rent or Mortgage |
| `Name Address Phone Number to Whom You Pay the BillLot Rent` | text | 178, 470, 187, 23 |  |  |  | Name, Address, Phone Number to Whom You Pay the Bill_Lot Rent |
| `Amount BilledLot Rent` | text | 367, 470, 75, 23 |  |  |  | Amount Billed_Lot Rent |
| `How Often PaidLot Rent` | text | 443, 470, 56, 23 |  |  |  | How Often Paid?_Lot Rent |
| `Who Pays the BillLot Rent` | text | 502, 470, 88, 23 |  |  |  | Who Pays the Bill?_Lot Rent |
| `Name Address Phone Number to Whom You Pay the BillProperty Taxes If not included in mortgage` | text | 178, 446, 187, 23 |  |  |  | Name, Address, Phone Number to Whom You Pay the Bill_Property Taxes (If not included in mortgage) |
| `Amount BilledProperty Taxes If not included in mortgage` | text | 367, 446, 75, 23 |  |  |  | Amount Billed_Property Taxes (If not included in mortgage) |
| `How Often PaidProperty Taxes If not included in mortgage` | text | 443, 446, 56, 23 |  |  |  | How Often Paid?_Property Taxes (If not included in mortgage) |
| `Who Pays the BillProperty Taxes If not included in mortgage` | text | 502, 446, 88, 23 |  |  |  | Who Pays the Bill?_Property Taxes (If not included in mortgage) |
| `Name Address Phone Number to Whom You Pay the BillHomeowners Insurance If not included in mortgage` | text | 178, 422, 187, 23 |  |  |  | Name, Address, Phone Number to Whom You Pay the Bill_Homeowners Insurance (If not included in mortgage) |
| `Amount BilledHomeowners Insurance If not included in mortgage` | text | 367, 422, 75, 23 |  |  |  | Amount Billed_Homeowners Insurance (If not included in mortgage) |
| `How Often PaidHomeowners Insurance If not included in mortgage` | text | 443, 422, 56, 23 |  |  |  | How Often Paid?_Homeowners Insurance (If not included in mortgage) |
| `Who Pays the BillHomeowners Insurance If not included in mortgage` | text | 502, 422, 88, 23 |  |  |  | Who Pays the Bill?_Homeowners Insurance (If not included in mortgage) |
| `Name Address Phone Number to Whom You Pay the BillHomeowners Dues HOA` | text | 178, 398, 187, 23 |  |  |  | Name, Address, Phone Number to Whom You Pay the Bill_Homeowners Dues (HOA) |
| `Amount BilledHomeowners Dues HOA` | text | 367, 398, 75, 23 |  |  |  | Amount Billed_Homeowners Dues (HOA) |
| `How Often PaidHomeowners Dues HOA` | text | 443, 398, 56, 23 |  |  |  | How Often Paid?_Homeowners Dues (HOA) |
| `Who Pays the BillHomeowners Dues HOA` | text | 502, 398, 88, 23 |  |  |  | Who Pays the Bill?_Homeowners Dues (HOA) |
| `Electricity` | checkbox | 42, 364, 10, 10 |  | Off, On |  | Electricity |
| `LPNatural Gas` | checkbox | 113, 364, 10, 10 |  | Off, On |  | LP/Natural Gas |
| `Utility Excess Public Housing` | checkbox | 210, 364, 10, 10 |  | Off, On |  | Utility Excess (Public Housing |
| `WaterSewage` | checkbox | 368, 364, 10, 10 |  | Off, On |  | Water/Sewage |
| `GarbageTrash` | checkbox | 457, 364, 10, 10 |  | Off, On |  | Garbage/Trash |
| `TelephoneCell Phone` | checkbox | 42, 342, 10, 10 |  | Off, On |  | Telephone/Cell Phone |
| `Name of phone company` | text | 281, 342, 117, 11 |  |  |  | Name of phone company |
| `How do you heat your home` | text | 169, 317, 117, 11 |  |  |  | How do you heat your home |
| `How do you cool your home` | text | 427, 317, 106, 11 |  |  |  | How do you cool your home |
| `Did you get a LowIncome Energy Assistance Program LIEAP check in another state or at your current residence that was` | text | 443, 289, 128, 11 |  |  |  | Did you get a Low-Income Energy Assistance Program (LIEAP) check in another state or at your current residence that was |
| `Yes_24` | checkbox | 326, 288, 10, 10 |  | Off, On |  | Yes |
| `No If yes who` | checkbox | 363, 288, 10, 10 |  | Off, On |  | No If yes, who |
| `Do you receive Section 8 or HUD Assistance` | radio | 246, 271, 10, 10 |  | Off, Yes_25 |  | Do you receive Section 8 or HUD Assistance |
| `Do you receive Section 8 or HUD Assistance` | radio | 283, 271, 10, 10 |  | No_17, Off |  | Do you receive Section 8 or HUD Assistance |
| `utilities` | radio | 78, 225, 10, 10 |  | Off, Yes_26 |  | utilities |
| `utilities` | radio | 115, 225, 10, 10 |  | No_18, Off |  | utilities |
| `Which Bill is PaidRow1` | text | 43, 161, 105, 22 |  |  |  | Which Bill is Paid?_Row_1 |
| `Name Address Phone Number of the Person That Pays the BillRow1` | text | 149, 161, 214, 22 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill?_Row_1 |
| `undefined_7` | radio | 370, 162, 10, 10 |  | Off, Yes_27 |  | undefined |
| `undefined_7` | radio | 404, 162, 10, 10 |  | No_19, Off |  | undefined |
| `Amount PaidYes No` | text | 441, 161, 47, 22 |  |  |  | Amount Paid_Yes No |
| `How Often PaidYes No` | text | 489, 161, 36, 22 |  |  |  | How Often Paid?_Yes No |
| `Date of Last PaymentYes No` | text | 527, 161, 57, 22 |  |  |  | Date of Last Payment_Yes No |
| `Which Bill is PaidRow2` | text | 43, 138, 105, 22 |  |  |  | Which Bill is Paid?_Row_2 |
| `Name Address Phone Number of the Person That Pays the BillRow2` | text | 149, 138, 214, 22 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill?_Row_2 |
| `undefined_8` | radio | 370, 138, 10, 10 |  | Off, Yes_28 |  | undefined |
| `undefined_8` | radio | 404, 138, 10, 10 |  | No_20, Off |  | undefined |
| `Amount PaidYes No_2` | text | 441, 138, 47, 22 |  |  |  | Amount Paid_Yes No |
| `How Often PaidYes No_2` | text | 489, 138, 36, 22 |  |  |  | How Often Paid?_Yes No |
| `Date of Last PaymentYes No_2` | text | 527, 138, 57, 22 |  |  |  | Date of Last Payment_Yes No |
| `Which Bill is PaidRow3` | text | 43, 113, 105, 23 |  |  |  | Which Bill is Paid?_Row_3 |
| `Name Address Phone Number of the Person That Pays the BillRow3` | text | 149, 113, 214, 23 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill?_Row_3 |
| `undefined_9` | radio | 370, 115, 10, 10 |  | Off, Yes_29 |  | undefined |
| `undefined_9` | radio | 404, 115, 10, 10 |  | No_21, Off |  | undefined |
| `Amount PaidYes No_3` | text | 441, 113, 47, 23 |  |  |  | Amount Paid_Yes No |
| `How Often PaidYes No_3` | text | 489, 113, 36, 23 |  |  |  | How Often Paid?_Yes No |
| `Date of Last PaymentYes No_3` | text | 527, 113, 56, 23 |  |  |  | Date of Last Payment_Yes No |
| `Which Bill is PaidRow4` | text | 43, 88, 105, 23 |  |  |  | Which Bill is Paid?_Row_4 |
| `Name Address Phone Number of the Person That Pays the BillRow4` | text | 149, 88, 214, 23 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill?_Row_4 |
| `undefined_10` | radio | 370, 90, 10, 10 |  | Off, Yes_30 |  | undefined |
| `undefined_10` | radio | 404, 90, 10, 10 |  | No_22, Off |  | undefined |
| `Amount PaidYes No_4` | text | 441, 88, 47, 23 |  |  |  | Amount Paid_Yes No |
| `How Often PaidYes No_4` | text | 489, 88, 36, 23 |  |  |  | How Often Paid?_Yes No |
| `Date of Last PaymentYes No_4` | text | 527, 88, 56, 23 |  |  |  | Date of Last Payment_Yes No |

## Page 7

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Yes_31` | checkbox | 355, 722, 10, 10 |  | Off, On |  | Yes |
| `No If yes complete questions below` | checkbox | 389, 722, 10, 10 |  | Off, On |  | No If yes, complete questions below |
| `Childdisabled adult care transportation expenses` | text | 254, 711, 300, 10 |  |  |  | Child/disabled adult care transportation expenses |
| `Who Gets the CareRow1` | text | 29, 634, 67, 11 |  |  |  | Who Gets the Care?_Row_1 |
| `Who Pays for the CareRow1` | text | 97, 634, 62, 11 |  |  |  | Who Pays for the Care?_Row_1 |
| `Name Address Phone Number of Care Provider or BabysitterRow1` | text | 160, 634, 147, 11 |  |  |  | Name, Address, Phone Number of Care Provider or Babysitter_Row_1 |
| `How Much is PaidRow1` | text | 309, 634, 44, 11 |  |  |  | How Much is Paid?_Row_1 |
| `How Often PaidRow1` | text | 354, 634, 44, 11 |  |  |  | How Often Paid?_Row_1 |
| `Start DateRow1_5` | text | 399, 634, 39, 11 |  |  |  | Start Date_Row_1 |
| `Why is Care NeededRow1` | text | 439, 634, 53, 11 |  |  |  | Why is Care Needed?_Row_1 |
| `Date of Last PaymentRow1` | text | 493, 634, 62, 11 |  |  |  | Date of Last Payment_Row_1 |
| `Number of Hours Per WeekRow1` | text | 556, 634, 48, 11 |  |  |  | Number of Hours Per Week_Row_1 |
| `Who Gets the CareRow2` | text | 29, 622, 67, 11 |  |  |  | Who Gets the Care?_Row_2 |
| `Who Pays for the CareRow2` | text | 97, 622, 62, 11 |  |  |  | Who Pays for the Care?_Row_2 |
| `Name Address Phone Number of Care Provider or BabysitterRow2` | text | 160, 622, 147, 11 |  |  |  | Name, Address, Phone Number of Care Provider or Babysitter_Row_2 |
| `How Much is PaidRow2` | text | 309, 622, 44, 11 |  |  |  | How Much is Paid?_Row_2 |
| `How Often PaidRow2` | text | 354, 622, 44, 11 |  |  |  | How Often Paid?_Row_2 |
| `Start DateRow2_5` | text | 399, 622, 39, 11 |  |  |  | Start Date_Row_2 |
| `Why is Care NeededRow2` | text | 439, 622, 53, 11 |  |  |  | Why is Care Needed?_Row_2 |
| `Date of Last PaymentRow2` | text | 493, 622, 62, 11 |  |  |  | Date of Last Payment_Row_2 |
| `Number of Hours Per WeekRow2` | text | 556, 622, 48, 11 |  |  |  | Number of Hours Per Week_Row_2 |
| `Who Gets the CareRow3` | text | 29, 610, 67, 11 |  |  |  | Who Gets the Care?_Row_3 |
| `Who Pays for the CareRow3` | text | 97, 610, 62, 11 |  |  |  | Who Pays for the Care?_Row_3 |
| `Name Address Phone Number of Care Provider or BabysitterRow3` | text | 160, 610, 147, 11 |  |  |  | Name, Address, Phone Number of Care Provider or Babysitter_Row_3 |
| `How Much is PaidRow3` | text | 309, 610, 44, 11 |  |  |  | How Much is Paid?_Row_3 |
| `How Often PaidRow3` | text | 354, 610, 44, 11 |  |  |  | How Often Paid?_Row_3 |
| `Start DateRow3_4` | text | 399, 610, 39, 11 |  |  |  | Start Date_Row_3 |
| `Why is Care NeededRow3` | text | 439, 610, 53, 11 |  |  |  | Why is Care Needed?_Row_3 |
| `Date of Last PaymentRow3` | text | 493, 610, 62, 11 |  |  |  | Date of Last Payment_Row_3 |
| `Number of Hours Per WeekRow3` | text | 556, 610, 48, 11 |  |  |  | Number of Hours Per Week_Row_3 |
| `If yes` | radio | 466, 588, 10, 10 |  | Off, Yes_32 |  | If yes |
| `If yes` | radio | 500, 588, 10, 10 |  | No_23, Off |  | If yes |
| `Which Bill is PaidRow1_2` | text | 30, 514, 106, 11 |  |  |  | Which Bill is Paid?_Row_1 |
| `Name Address Phone Number of the Person That Pays the BillRow1_2` | text | 137, 514, 309, 11 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill_Row_1 |
| `Amount PaidRow1` | text | 447, 514, 57, 11 |  |  |  | Amount Paid_Row_1 |
| `How Often PaidRow1_2` | text | 505, 514, 37, 11 |  |  |  | How Often Paid?_Row_1 |
| `Date of Last PaymentRow1_2` | text | 543, 514, 57, 11 |  |  |  | Date of Last Payment_Row_1 |
| `Which Bill is PaidRow2_2` | text | 30, 502, 106, 11 |  |  |  | Which Bill is Paid?_Row_2 |
| `Name Address Phone Number of the Person That Pays the BillRow2_2` | text | 137, 502, 309, 11 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill_Row_2 |
| `Amount PaidRow2` | text | 447, 502, 57, 11 |  |  |  | Amount Paid_Row_2 |
| `How Often PaidRow2_2` | text | 505, 502, 37, 11 |  |  |  | How Often Paid?_Row_2 |
| `Date of Last PaymentRow2_2` | text | 543, 502, 57, 11 |  |  |  | Date of Last Payment_Row_2 |
| `Which Bill is PaidRow3_2` | text | 30, 490, 106, 11 |  |  |  | Which Bill is Paid?_Row_3 |
| `Name Address Phone Number of the Person That Pays the BillRow3_2` | text | 137, 490, 309, 11 |  |  |  | Name, Address, Phone Number of the Person That Pays the Bill_Row_3 |
| `Amount PaidRow3` | text | 447, 490, 57, 11 |  |  |  | Amount Paid_Row_3 |
| `How Often PaidRow3_2` | text | 505, 490, 37, 11 |  |  |  | How Often Paid?_Row_3 |
| `Date of Last PaymentRow3_2` | text | 543, 490, 57, 11 |  |  |  | Date of Last Payment_Row_3 |
| `Yes_33` | checkbox | 77, 456, 10, 10 |  | Off, On |  | Yes |
| `No If yes complete questions below_2` | checkbox | 111, 456, 10, 10 |  | Off, On |  | No If yes, complete questions below |
| `Who Pays the Child SupportRow1` | text | 30, 406, 91, 11 |  |  |  | Who Pays the Child Support?_Row_1 |
| `Name of ChildRow1` | text | 122, 406, 70, 11 |  |  |  | Name of Child?_Row_1 |
| `Name Address and Phone Number of Person That Pays the Child SupportRow1` | text | 193, 406, 199, 11 |  |  |  | Name, Address and Phone Number of Person That Pays the Child Support_Row_1 |
| `Amount PaidRow1_2` | text | 393, 406, 48, 11 |  |  |  | Amount Paid_Row_1 |
| `Start DateRow1_6` | text | 441, 406, 57, 11 |  |  |  | Start Date_Row_1 |
| `How Often PaidRow1_3` | text | 499, 406, 37, 11 |  |  |  | How Often Paid?_Row_1 |
| `Date of Last PaymentRow1_3` | text | 537, 406, 64, 11 |  |  |  | Date of Last Payment_Row_1 |
| `Who Pays the Child SupportRow2` | text | 30, 394, 91, 11 |  |  |  | Who Pays the Child Support?_Row_2 |
| `Name of ChildRow2` | text | 122, 394, 70, 11 |  |  |  | Name of Child?_Row_2 |
| `Name Address and Phone Number of Person That Pays the Child SupportRow2` | text | 193, 394, 199, 11 |  |  |  | Name, Address and Phone Number of Person That Pays the Child Support_Row_2 |
| `Amount PaidRow2_2` | text | 393, 394, 48, 11 |  |  |  | Amount Paid_Row_2 |
| `Start DateRow2_6` | text | 441, 394, 57, 11 |  |  |  | Start Date_Row_2 |
| `How Often PaidRow2_3` | text | 499, 394, 37, 11 |  |  |  | How Often Paid?_Row_2 |
| `Date of Last PaymentRow2_3` | text | 537, 394, 64, 11 |  |  |  | Date of Last Payment_Row_2 |
| `Who Pays the Child SupportRow3` | text | 30, 382, 91, 11 |  |  |  | Who Pays the Child Support?_Row_3 |
| `Name of ChildRow3` | text | 122, 382, 70, 11 |  |  |  | Name of Child?_Row_3 |
| `Name Address and Phone Number of Person That Pays the Child SupportRow3` | text | 193, 382, 199, 11 |  |  |  | Name, Address and Phone Number of Person That Pays the Child Support_Row_3 |
| `Amount PaidRow3_2` | text | 393, 382, 48, 11 |  |  |  | Amount Paid_Row_3 |
| `Start DateRow3_5` | text | 441, 382, 57, 11 |  |  |  | Start Date_Row_3 |
| `How Often PaidRow3_3` | text | 499, 382, 37, 11 |  |  |  | How Often Paid?_Row_3 |
| `Date of Last PaymentRow3_3` | text | 537, 382, 64, 11 |  |  |  | Date of Last Payment_Row_3 |
| `Benefits for 100 Disability or Medicaid for disabled persons` | checkbox | 241, 314, 10, 10 |  | Off, On |  | Benefits for 100% Disability, or Medicaid for disabled persons |
| `Yes_34` | checkbox | 204, 314, 10, 10 |  | Off, On |  | Yes |
| `No If yes who_2` | text | 328, 315, 122, 10 |  |  |  | No If yes, who |
| `begin` | text | 60, 303, 122, 10 |  |  |  | begin |
| `Who made the disability determination` | text | 363, 303, 183, 10 |  |  |  | Who made the disability determination |
| `Type of ExpenseRow1` | text | 33, 137, 89, 11 |  |  |  | Type of Expense_Row_1 |
| `When Did the Expense StartRow1` | text | 123, 137, 89, 11 |  |  |  | When Did the Expense Start?_Row_1 |
| `Name Address Phone Number of Medical ProviderRow1` | text | 213, 137, 197, 11 |  |  |  | Name, Address, Phone Number of Medical Provider_Row_1 |
| `Amount PaidRow1_3` | text | 411, 137, 70, 11 |  |  |  | Amount Paid_Row_1 |
| `How Often PaidRow1_4` | text | 483, 137, 57, 11 |  |  |  | How Often Paid?_Row_1 |
| `Date of Last PaymentRow1_4` | text | 541, 137, 62, 11 |  |  |  | Date of Last Payment_Row_1 |
| `Type of ExpenseRow2` | text | 33, 124, 89, 11 |  |  |  | Type of Expense_Row_2 |
| `When Did the Expense StartRow2` | text | 123, 124, 89, 11 |  |  |  | When Did the Expense Start?_Row_2 |
| `Name Address Phone Number of Medical ProviderRow2` | text | 213, 124, 197, 11 |  |  |  | Name, Address, Phone Number of Medical Provider_Row_2 |
| `Amount PaidRow2_3` | text | 411, 124, 70, 11 |  |  |  | Amount Paid_Row_2 |
| `How Often PaidRow2_4` | text | 483, 124, 57, 11 |  |  |  | How Often Paid?_Row_2 |
| `Date of Last PaymentRow2_4` | text | 541, 124, 62, 11 |  |  |  | Date of Last Payment_Row_2 |
| `Yes_35` | checkbox | 457, 108, 9, 9 |  | Off, On |  | Yes |
| `No If yes` | checkbox | 492, 108, 9, 9 |  | Off, On |  | No If yes |
| `Who Pays the Bill` | text | 109, 82, 79, 10 |  |  |  | Who Pays the Bill |
| `Which Bill Is Paid` | text | 273, 82, 79, 10 |  |  |  | Which Bill Is Paid |
| `Amount per month` | text | 435, 82, 79, 10 |  |  |  | Amount per month |
| `Who Pays the Bill_2` | text | 109, 72, 79, 10 |  |  |  | Who Pays the Bill |
| `Which Bill Is Paid_2` | text | 273, 72, 79, 10 |  |  |  | Which Bill Is Paid |
| `Amount per month_2` | text | 435, 72, 79, 10 |  |  |  | Amount per month |

## Page 8

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `If you are not registered to vote where you live now would you like to apply to register to vote here today` | radio | 455, 319, 8, 6 |  | Off, Yes_36 |  | If you are not registered to vote where you live now, would you like to apply to register to vote here today |
| `If you are not registered to vote where you live now would you like to apply to register to vote here today` | radio | 487, 319, 8, 6 |  | No_24, Off |  | If you are not registered to vote where you live now, would you like to apply to register to vote here today |
| `Your Signature or Authorized Representative` | signature | 231, 196, 171, 14 |  |  |  | Your Signature or Authorized Representative |
| `Date Signed` | text | 454, 196, 122, 14 |  |  |  | Date Signed |
| `First Name Middle Initial Last Name` | text | 375, 165, 214, 19 |  |  |  | First Name Middle Initial Last Name |
| `Home Phone` | text | 41, 109, 90, 10 |  |  |  | Home Phone |
| `Cell Phone` | text | 132, 109, 84, 10 |  |  |  | Cell Phone |
| `Message Number` | text | 218, 109, 101, 10 |  |  |  | Message Number |
| `Telephone Company Provider` | text | 320, 109, 161, 10 |  |  |  | Telephone Company Provider |
| `Language you speak` | text | 482, 109, 107, 10 |  |  |  | Language you speak |
| `undefined_11` | text | 140, 91, 58, 14 |  |  |  | undefined |
| `undefined_12` | text | 198, 91, 86, 14 |  |  |  | undefined |
| `Email Address voluntary` | text | 284, 90, 305, 18 |  |  |  | Email Address (voluntary) |
| `Telephone` | checkbox | 352, 56, 6, 5 |  | Off, On |  | Telephone |
| `Office visit` | checkbox | 401, 56, 6, 5 |  | Off, On |  | Office visit |
| `Text1` | text | 86, 165, 160, 19 |  |  |  |  |
| `Text2` | text | 295, 166, 40, 17 |  |  |  |  |
| `Text3` | text | 116, 146, 157, 17 |  |  |  |  |
| `Text4` | text | 289, 146, 58, 17 |  |  |  |  |
| `Text5` | text | 370, 146, 58, 17 |  |  |  |  |
| `Text6` | text | 462, 147, 125, 15 |  |  |  |  |
| `Text7` | text | 106, 127, 166, 12 |  |  |  |  |
| `Text8` | text | 289, 127, 60, 17 |  |  |  |  |
| `Text9` | text | 369, 128, 58, 15 |  |  |  |  |
| `Text10` | text | 465, 127, 121, 17 |  |  |  |  |

## Page 9

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Changes You Must Report and How to Report Them` | text | 263, 716, 314, 10 |  |  |  | Changes You Must Report and How to Report Them |
| `Information About Social Security Numbers` | text | 228, 664, 349, 10 |  |  |  | Information About Social Security Numbers |
| `Information About US Citizenship and Immigration Status` | text | 292, 591, 285, 10 |  |  |  | Information About U.S. Citizenship and Immigration Status |
| `Food and Nutrition Services Rules` | text | 188, 502, 389, 10 |  |  |  | Food and Nutrition Services Rules |
| `Penalties for Breaking the Rules of the Food and Nutrition Services Program` | text | 368, 348, 209, 10 |  |  |  | Penalties for Breaking the Rules of the Food and Nutrition Services Program |
| `Information About Hearings` | text | 160, 159, 417, 10 |  |  |  | Information About Hearings |

## Page 10

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `We Check What You Tell Us` | text | 160, 745, 424, 10 |  |  |  | We Check What You Tell Us |
| `You Will Not Be Discriminated Against` | text | 211, 542, 373, 10 |  |  |  | You Will Not Be Discriminated Against |
