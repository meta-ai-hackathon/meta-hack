# DHB-5200 field inventory (per page)

Generated from the committed template `dhb-5200-ia-9-2020.pdf` by
`scripts/dhb5200_field_inventory.py` (pypdf page-annotation walk).
Regenerate with `python3 scripts/dhb5200_field_inventory.py` from
the repo root. Every AcroForm widget appears under its page with
its type, rectangle (x, y, width, height - PDF origin bottom-left),
read-only flag, checkbox/radio export values, choice options, any
pre-printed value, and the printed label evidence (the /TU tooltip
the form author wrote).

Counts: this walk sees
 615 widgets across 572 named fields (including
 the print pushbutton, which is not fillable). The app's discovery
 pass (discoverAcroFormFields, @cantoo/pdf-lib) sees exactly this
 walk minus the pushbutton: 614 widgets across 571 named fields -
 the count the registry test pins.

| page | widgets | named fields | types |
|---|---|---|---|
| 1 | 1 | 1 | pushbutton 1 |
| 2 | 18 | 18 | checkbox 2, text 16 |
| 3 | 47 | 43 | checkbox 21, radio 8, text 18 |
| 4 | 19 | 12 | checkbox 4, radio 14, text 1 |
| 5 | 57 | 57 | checkbox 28, text 29 |
| 6 | 13 | 13 | checkbox 3, text 10 |
| 7 | 46 | 42 | checkbox 21, radio 8, text 17 |
| 8 | 24 | 19 | checkbox 10, radio 10, text 4 |
| 9 | 58 | 58 | checkbox 28, text 30 |
| 10 | 13 | 13 | checkbox 3, text 10 |
| 11 | 47 | 43 | checkbox 21, radio 8, text 18 |
| 12 | 24 | 18 | checkbox 8, radio 12, text 4 |
| 13 | 57 | 57 | checkbox 28, text 29 |
| 14 | 14 | 14 | checkbox 3, text 11 |
| 15 | 47 | 43 | checkbox 21, radio 8, text 18 |
| 16 | 24 | 20 | checkbox 12, radio 8, text 4 |
| 17 | 57 | 57 | checkbox 28, text 29 |
| 18 | 13 | 13 | checkbox 3, text 10 |
| 19 | 26 | 22 | checkbox 9, radio 8, text 9 |
| 20 | 8 | 8 | checkbox 6, text 2 |
| 21 | 2 | 1 | radio 2 |

## Page 1

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Print Form` | pushbutton | 532, 775, 80, 17 |  |  |  | Print this form |

## Page 2

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `1 First name Middle name Last name  Suffix` | text | 37, 690, 538, 19 |  |  |  | 1. First name, Middle name, Last name & Suffix |
| `2 Home address Leave blank if you dont have one` | text | 37, 662, 385, 17 |  |  |  | 2. Home address (Leave blank if you don’t have one) |
| `3 Apartment or Suite Number` | text | 424, 662, 151, 17 |  |  |  | 3. Apartment or Suite Number |
| `4 City` | text | 37, 635, 160, 15 |  |  |  | 4. City |
| `5 State` | text | 199, 635, 124, 17 |  |  |  | 5. State |
| `6 Zip Code` | text | 325, 635, 97, 17 |  |  |  | 6. Zip Code |
| `7 County` | text | 424, 635, 151, 17 |  |  |  | 7. County |
| `8 Mailing Address if different from home address` | text | 37, 593, 384, 29 |  |  |  | 8. Mailing Address (if different from home address) |
| `9 Apartment of Suite Number` | text | 424, 593, 150, 29 |  |  |  | 9. Apartment of Suite Number |
| `10 City` | text | 37, 567, 160, 15 |  |  |  | 10. City |
| `11 State` | text | 199, 567, 124, 17 |  |  |  | 11. State |
| `12 Zip Code` | text | 325, 567, 97, 17 |  |  |  | 12. Zip Code |
| `13 County` | text | 424, 567, 151, 17 |  |  |  | 13. County |
| `14 Phone Number` | text | 37, 541, 286, 15 |  |  |  | 14. Phone Number |
| `15 Other Phone Number` | text | 325, 541, 250, 17 |  |  |  | 15. Other Phone Number |
| `16 What is your preferred spoken or written language if not English` | text | 37, 499, 537, 29 |  |  |  | 16. What is your preferred spoken or written language (if not English)? |
| `If you are NOT registered to vote where you live now would you like to register to vote here today` | checkbox | 77, 474, 7, 9 |  | Off, On |  | If you are NOT registered to vote where you live now, would you like to register to vote here today |
| `Yes` | checkbox | 110, 474, 7, 9 |  | Off, On |  | Yes |

## Page 3

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Complete Step 2 for yourself your spouse your children under age 21 who live with you and anyone you claimed on` | text | 36, 714, 540, 12 |  |  |  | Complete Step 2 for yourself, your spouse, your children under age 21 who live with you and anyone you claimed on |
| `1 First name Middle name Last name and Suffix` | text | 36, 652, 401, 14 |  |  |  | 1. First name, Middle name, Last name and Suffix |
| `undefined` | text | 177, 639, 135, 12 |  |  |  | undefined |
| `3 Date of Birth mmddyyyy` | text | 36, 626, 303, 12 |  |  |  | 3. Date of Birth (mm/dd/yyyy): |
| `4 Sex Male Female` | text | 340, 626, 236, 14 |  |  |  | 4. Sex Male Female |
| `undefined_2` | checkbox | 387, 640, 7, 9 |  | Off, On |  | undefined |
| `undefined_3` | checkbox | 429, 640, 7, 9 |  | Off, On |  | undefined |
| `5 Social Security Number SSN` | text | 193, 614, 112, 12 |  |  |  | 5. Social Security Number (SSN |
| `Yes_2` | checkbox | 73, 538, 7, 9 |  | Off, On |  | Yes |
| `Will you file jointly with a spouse` | radio | 238, 509, 7, 9 |  | Off, Yes_3 |  | Will you file jointly with a spouse |
| `Will you file jointly with a spouse` | radio | 273, 509, 7, 9 |  | No, Off |  | Will you file jointly with a spouse |
| `Will you claim any dependents on your tax return` | radio | 305, 538, 7, 9 |  | No_2, Off |  | Will you claim any dependents on your tax return |
| `Will you claim any dependents on your tax return` | radio | 303, 479, 7, 9 |  | Off, Yes_4 |  | Will you claim any dependents on your tax return |
| `If yes name of spouse` | text | 419, 508, 123, 12 |  |  |  | If yes, name of spouse |
| `No_3` | checkbox | 336, 479, 7, 9 |  | Off, On |  | No |
| `If yes list name s of dependents` | text | 233, 463, 163, 12 |  |  |  | If yes, list name (s) of dependents |
| `Will you be claimed as a dependent on someone elses tax return` | radio | 375, 436, 7, 9 |  | Off, Yes_5 |  | Will you be claimed as a dependent on someone else’s tax return |
| `Will you be claimed as a dependent on someone elses tax return` | radio | 413, 436, 7, 9 |  | No_4, Off |  | Will you be claimed as a dependent on someone else’s tax return |
| `If yes please list the name of the tax filer` | text | 264, 419, 252, 12 |  |  |  | If yes, please list the name of the tax filer |
| `How are you related to this tax filer` | text | 240, 406, 274, 12 |  |  |  | How are you related to this tax filer |
| `7` | text | 41, 389, 14, 12 |  |  |  | 7 |
| `Do you need health coverage` | text | 59, 389, 517, 12 |  |  |  | Do you need health coverage? |
| `Yes If yes answer all the questions below` | checkbox | 65, 348, 7, 9 |  | Off, On |  | Yes, If yes, answer all the questions below |
| `No If no SKIP to the income question on page 4 Leave the rest of this section blank` | checkbox | 65, 328, 7, 9 |  | Off, On |  | No, If no, SKIP to the income question on page 4. Leave the rest of this section blank |
| `Are you a US citizen or US National` | radio | 245, 310, 7, 9 |  | Off, Yes_6 |  | Are you a U.S. citizen or U.S. National |
| `Are you a US citizen or US National` | radio | 280, 310, 7, 9 |  | No_5, Off |  | Are you a U.S. citizen or U.S. National |
| `Yes Fill in your document type and ID number below` | checkbox | 58, 262, 7, 9 |  | Off, On |  | Yes. Fill in your document type and ID number below |
| `Immigration document type` | text | 202, 248, 90, 12 |  |  |  | Immigration document type |
| `Document ID number` | text | 177, 237, 112, 10 |  |  |  | Document ID number |
| `Date of entry into the US` | text | 197, 225, 90, 11 |  |  |  | Date of entry into the U.S |
| `Mexican` | checkbox | 58, 157, 7, 9 |  | Off, On |  | Mexican |
| `MexicanAmerican` | checkbox | 117, 157, 7, 9 |  | Off, On |  | Mexican-American |
| `Puerto Rican` | checkbox | 221, 157, 7, 9 |  | Off, On |  | Puerto Rican |
| `Cuban` | checkbox | 301, 157, 7, 9 |  | Off, On |  | Cuban |
| `Other` | checkbox | 346, 157, 7, 9 |  | Off, On |  | Other |
| `undefined_4` | text | 387, 156, 151, 12 |  |  |  | undefined |
| `11 Race OPTIONAL  Check all that apply` | text | 36, 136, 540, 12 |  |  |  | 11. Race (OPTIONAL – Check all that apply |
| `White or Caucasian` | checkbox | 60, 110, 7, 9 |  | Off, On |  | White or Caucasian |
| `Other Pacific Islander` | checkbox | 60, 96, 7, 9 |  | Off, On |  | Other Pacific Islander |
| `American Indian or Alaska Native If you complete Appendix B` | checkbox | 60, 83, 7, 9 |  | Off, On |  | American Indian or Alaska Native (If you, complete Appendix B |
| `Other_2` | checkbox | 60, 69, 7, 9 |  | Off, On |  | Other |
| `Black or AfricanAmerican` | checkbox | 164, 110, 7, 9 |  | Off, On |  | Black or African-American |
| `Asian` | checkbox | 297, 110, 7, 9 |  | Off, On |  | Asian |
| `Native Hawaiian` | checkbox | 339, 110, 7, 9 |  | Off, On |  | Native Hawaiian |
| `undefined_5` | text | 102, 68, 145, 12 |  |  |  | undefined |
| `Check Box9` | checkbox | 465, 211, 9, 7 |  | Yes |  |  |
| `Check Box10` | checkbox | 495, 211, 9, 7 |  | Yes |  |  |

## Page 4

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `12 Are you a resident of North Carolina` | radio | 238, 728, 7, 9 |  | Off, Yes_9 |  | 12. Are you a resident of North Carolina |
| `12 Are you a resident of North Carolina` | radio | 290, 728, 7, 9 |  | No_8, Off |  | 12. Are you a resident of North Carolina |
| `13 Are you pregnant` | radio | 152, 712, 7, 9 |  | Off, Yes_10 |  | 13. Are you pregnant |
| `13 Are you pregnant` | radio | 188, 712, 7, 9 |  | No_9, Off |  | 13. Are you pregnant |
| `If yes how many babies are expected during this pregnancy` | text | 505, 711, 52, 15 |  |  |  | If yes, how many babies are expected during this pregnancy |
| `are you the main person taking care of that child` | radio | 58, 661, 7, 9 |  | Off, Yes_11 |  | are you the main person taking care of that child |
| `are you the main person taking care of that child` | radio | 118, 661, 7, 9 |  | No_10, Off |  | are you the main person taking care of that child |
| `you turned 18` | radio | 349, 661, 7, 9 |  | Off, Yes_12 |  | you turned 18 |
| `you turned 18` | radio | 407, 661, 7, 9 |  | No_11, Off |  | you turned 18 |
| `undefined_6` | checkbox | 58, 633, 7, 9 |  | Off, On |  | undefined |
| `undefined_7` | checkbox | 118, 633, 7, 9 |  | Off, On |  | undefined |
| `16b Are you aged 65 or older` | radio | 241, 631, 7, 9 |  | Off, Yes_13 |  | 16b. Are you aged 65 or older |
| `16b Are you aged 65 or older` | radio | 299, 631, 7, 9 |  | No_12, Off |  | 16b. Are you aged 65 or older |
| `undefined_8` | checkbox | 426, 631, 7, 9 |  | Off, On |  | undefined |
| `undefined_9` | checkbox | 484, 631, 7, 9 |  | Off, On |  | undefined |
| `such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and` | radio | 239, 592, 7, 9 |  | Off, Yes_14 |  | such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and` | radio | 299, 592, 7, 9 |  | No_13, Off |  | such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `Do you want help paying for medical bills in the last 3 months` | radio | 334, 576, 7, 9 |  | Off, Yes_15 |  | Do you want help paying for medical bills in the last 3 months |
| `Do you want help paying for medical bills in the last 3 months` | radio | 376, 576, 7, 9 |  | No_14, Off |  | Do you want help paying for medical bills in the last 3 months |

## Page 5

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Employed` | checkbox | 61, 674, 11, 14 |  | Off, On |  | Employed |
| `SelfEmployed` | checkbox | 259, 674, 10, 14 |  | Off, On |  | Self-Employed |
| `Not employed` | checkbox | 412, 674, 11, 14 |  | Off, On |  | Not employed |
| `Text1` | text | 40, 584, 388, 25 |  |  |  |  |
| `21 Employer phone number` | text | 437, 590, 143, 16 |  |  |  | 21. Employer phone number: ( ) - |
| `Check Box5` | checkbox | 183, 567, 8, 9 |  | Off, Yes |  |  |
| `Weekly` | checkbox | 230, 568, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks` | checkbox | 279, 568, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly` | checkbox | 358, 568, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly` | checkbox | 444, 568, 7, 9 |  | Off, On |  | Monthly |
| `Yearly` | checkbox | 496, 568, 7, 9 |  | Off, On |  | Yearly |
| `undefined_10` | text | 69, 553, 128, 13 |  |  |  | undefined |
| `23 Average hours worked each WEEK` | text | 219, 525, 151, 12 |  |  |  | 23. Average hours worked each WEEK |
| `Text2` | text | 37, 443, 397, 26 |  |  |  |  |
| `25 Employer phone number` | text | 437, 455, 140, 16 |  |  |  | 25. Employer phone number: ( ) - |
| `Hourly_2` | checkbox | 177, 430, 7, 9 |  | Off, On |  | Hourly |
| `Weekly_2` | checkbox | 223, 430, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks_2` | checkbox | 274, 430, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly_2` | checkbox | 352, 430, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly_2` | checkbox | 438, 430, 7, 9 |  | Off, On |  | Monthly |
| `Yearly_2` | checkbox | 491, 430, 7, 9 |  | Off, On |  | Yearly |
| `undefined_11` | text | 60, 415, 178, 13 |  |  |  | undefined |
| `27 Average hours worked each WEEK` | text | 219, 388, 151, 12 |  |  |  | 27. Average hours worked each WEEK |
| `Change Jobs` | checkbox | 58, 345, 7, 9 |  | Off, On |  | Change Jobs |
| `Stop Working` | checkbox | 171, 345, 7, 9 |  | Off, On |  | Stop Working |
| `Start working fewer hours` | checkbox | 281, 345, 7, 9 |  | Off, On |  | Start working fewer hours |
| `None of these` | checkbox | 435, 345, 7, 9 |  | Off, On |  | None of these |
| `Type of work` | text | 139, 315, 168, 13 |  |  |  | Type of work |
| `month` | text | 113, 290, 167, 12 |  |  |  | month |
| `None` | checkbox | 60, 224, 7, 9 |  | On |  | None |
| `undefined_12` | text | 177, 223, 33, 13 |  |  |  | undefined |
| `How Often` | text | 264, 224, 39, 13 |  |  |  | How Often |
| `Net farmingfishing` | checkbox | 331, 224, 7, 10 |  | On |  | Net farming/fishing |
| `undefined_13` | text | 444, 223, 34, 13 |  |  |  | undefined |
| `How Often_2` | text | 530, 224, 36, 13 |  |  |  | How Often |
| `Unemployment` | checkbox | 61, 207, 7, 9 |  | Off, On |  | Unemployment |
| `undefined_14` | text | 177, 209, 33, 13 |  |  |  | undefined |
| `How Often_3` | text | 264, 208, 38, 13 |  |  |  | How Often |
| `Net rentalroyalty` | checkbox | 331, 209, 7, 9 |  | Off, On |  | Net rental/royalty |
| `undefined_15` | text | 444, 209, 33, 13 |  |  |  | undefined |
| `How Often_4` | text | 529, 209, 39, 13 |  |  |  | How Often |
| `Pensions` | checkbox | 61, 192, 7, 9 |  | Off, On |  | Pensions |
| `undefined_16` | text | 177, 194, 33, 13 |  |  |  | undefined |
| `How Often_5` | text | 264, 192, 39, 13 |  |  |  | How Often |
| `Other income` | checkbox | 331, 191, 7, 9 |  | Off, On |  | Other income |
| `undefined_17` | text | 437, 193, 34, 13 |  |  |  | undefined |
| `How Often_6` | text | 533, 193, 34, 13 |  |  |  | How Often |
| `Social Security` | checkbox | 61, 177, 7, 9 |  | Off, On |  | Social Security |
| `1` | text | 176, 178, 34, 13 |  |  |  | [1] |
| `How Often_7` | text | 264, 177, 39, 13 |  |  |  | How Often |
| `Type` | text | 398, 179, 167, 12 |  |  |  | Type |
| `Retirement Accounts` | checkbox | 61, 161, 7, 9 |  | Off, On |  | Retirement Accounts |
| `2` | text | 177, 163, 34, 13 |  |  |  | [2] |
| `How Often_8` | text | 265, 162, 37, 13 |  |  |  | How Often |
| `Alimony Received` | checkbox | 61, 146, 7, 9 |  | Off, On |  | Alimony Received |
| `undefined_18` | text | 177, 146, 33, 13 |  |  |  | undefined |
| `How Often_9` | text | 264, 146, 38, 13 |  |  |  | How Often |

## Page 6

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `31 DEDUCTIONS Check all that apply and give the amount and how often you get it` | text | 36, 755, 560, 15 |  |  |  | 31. DEDUCTIONS: Check all that apply, and give the amount and how often you get it |
| `Alimony Paid` | checkbox | 55, 690, 7, 9 |  | Off, On |  | Alimony Paid |
| `Student Loan Interest` | checkbox | 55, 675, 7, 9 |  | Off, On |  | Student Loan Interest |
| `Other Deductions` | checkbox | 55, 659, 7, 9 |  | Off, On |  | Other Deductions |
| `undefined_19` | text | 178, 689, 34, 15 |  |  |  | undefined |
| `undefined_20` | text | 176, 674, 34, 15 |  |  |  | undefined |
| `How Often_10` | text | 265, 673, 45, 15 |  |  |  | How Often |
| `undefined_21` | text | 175, 658, 34, 15 |  |  |  | undefined |
| `How Often_11` | text | 266, 658, 45, 15 |  |  |  | How Often |
| `Type_2` | text | 353, 658, 112, 15 |  |  |  | Type |
| `undefined_22` | text | 193, 592, 95, 15 |  |  |  | undefined |
| `undefined_23` | text | 339, 579, 117, 15 |  |  |  | undefined |
| `Your total income next year if you think it will be different` | text | 35, 564, 561, 14 |  |  |  | Your total income next year (if you think it will be different |

## Page 7

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Complete Step 2 for PERSON 2 their spouse their children under age 21 who live with them and anyone they claimed` | text | 35, 714, 540, 12 |  |  |  | Complete Step 2 for PERSON 2, their spouse, their children under age 21 who live with them and anyone they claimed |
| `1 First name Middle name Last name and Suffix_2` | text | 36, 651, 414, 15 |  |  |  | 1. First name, Middle name, Last name and Suffix |
| `2 Relationship to you` | text | 451, 651, 124, 17 |  |  |  | 2. Relationship to you: |
| `undefined_24` | text | 176, 638, 135, 12 |  |  |  | undefined |
| `3 Date of Birth mmddyyyy_2` | text | 36, 625, 296, 12 |  |  |  | 3. Date of Birth (mm/dd/yyyy): |
| `4 Sex Male Female_2` | text | 334, 625, 241, 14 |  |  |  | 4. Sex Male Female |
| `undefined_25` | checkbox | 381, 639, 7, 9 |  | Off, On |  | undefined |
| `undefined_26` | checkbox | 423, 639, 7, 9 |  | Off, On |  | undefined |
| `5 Social Security Number SSN_2` | text | 192, 613, 113, 12 |  |  |  | 5. Social Security Number (SSN |
| `Yes_16` | checkbox | 72, 558, 7, 9 |  | Off, On |  | Yes |
| `If yes please answer question ac` | radio | 306, 558, 7, 9 |  | No_15, Off |  | If yes, please answer question a-c |
| `If yes please answer question ac` | radio | 306, 529, 7, 9 |  | No_16, Off |  | If yes, please answer question a-c |
| `Yes_17` | checkbox | 271, 529, 7, 9 |  | Off, On |  | Yes |
| `If yes name of spouse_2` | text | 452, 528, 115, 12 |  |  |  | If yes, name of spouse |
| `Will PERSON 2 claim any dependents on their tax return` | radio | 337, 501, 7, 9 |  | Off, Yes_18 |  | Will PERSON 2 claim any dependents on their tax return |
| `Will PERSON 2 claim any dependents on their tax return` | radio | 369, 501, 7, 9 |  | No_17, Off |  | Will PERSON 2 claim any dependents on their tax return |
| `If yes list name s of dependents_2` | text | 230, 485, 163, 12 |  |  |  | If yes, list name (s) of dependents |
| `c Will PERSON 2 be claimed as a dependent on someone elses tax return` | radio | 404, 457, 7, 9 |  | Off, Yes_19 |  | c. Will PERSON 2 be claimed as a dependent on someone else’s tax return |
| `c Will PERSON 2 be claimed as a dependent on someone elses tax return` | radio | 439, 457, 7, 9 |  | No_18, Off |  | c. Will PERSON 2 be claimed as a dependent on someone else’s tax return |
| `If yes please list the name of the tax filer_2` | text | 258, 431, 274, 12 |  |  |  | If yes, please list the name of the tax filer |
| `Is PERSON 2 related to this tax filer If so how` | text | 289, 418, 241, 12 |  |  |  | Is PERSON 2 related to this tax filer? If so, how |
| `Yes If yes answer all the questions below_2` | checkbox | 64, 374, 7, 9 |  | Off, On |  | Yes, If yes, answer all the questions below |
| `No If no SKIP to the income question on page 8 Leave the rest of this section blank` | checkbox | 64, 357, 7, 9 |  | Off, On |  | No, If no, SKIP to the income question on page 8. Leave the rest of this section blank |
| `Is PERSON 2 a US citizen or US National` | radio | 272, 339, 7, 9 |  | Off, Yes_20 |  | Is PERSON 2 a U.S. citizen or U.S. National |
| `Is PERSON 2 a US citizen or US National` | radio | 306, 339, 7, 9 |  | No_19, Off |  | Is PERSON 2 a U.S. citizen or U.S. National |
| `Yes Fill in their document type and ID number below` | checkbox | 57, 291, 7, 9 |  | Off, On |  | Yes. Fill in their document type and ID number below |
| `Immigration document type_2` | text | 202, 276, 90, 12 |  |  |  | Immigration document type |
| `Document ID number_2` | text | 177, 264, 112, 11 |  |  |  | Document ID number |
| `Date of entry into the US_2` | text | 197, 252, 90, 12 |  |  |  | Date of entry into the U.S |
| `Mexican_2` | checkbox | 57, 185, 7, 9 |  | Off, On |  | Mexican |
| `MexicanAmerican_2` | checkbox | 116, 185, 7, 9 |  | Off, On |  | Mexican-American |
| `Puerto Rican_2` | checkbox | 221, 185, 7, 9 |  | Off, On |  | Puerto Rican |
| `Cuban_2` | checkbox | 300, 185, 7, 9 |  | Off, On |  | Cuban |
| `undefined_27` | checkbox | 346, 185, 7, 9 |  | Off, On |  | undefined |
| `Other_3` | text | 387, 184, 151, 12 |  |  |  | Other |
| `11 Race OPTIONAL  Check all that apply_2` | text | 35, 166, 540, 12 |  |  |  | 11. Race (OPTIONAL – Check all that apply |
| `White or Caucasian_2` | checkbox | 61, 139, 7, 9 |  | Off, On |  | White or Caucasian |
| `Other Pacific Islander_2` | checkbox | 60, 123, 7, 9 |  | Off, On |  | Other Pacific Islander |
| `American Indian or Alaska Native If so complete Appendix B` | checkbox | 61, 108, 7, 9 |  | Off, On |  | American Indian or Alaska Native (If so, complete Appendix B |
| `undefined_28` | checkbox | 60, 92, 7, 9 |  | Off, On |  | undefined |
| `Black or AfricanAmerican_2` | checkbox | 164, 139, 7, 9 |  | Off, On |  | Black or African-American |
| `Asian_2` | checkbox | 294, 139, 7, 9 |  | Off, On |  | Asian |
| `Native Hawaiian_2` | checkbox | 335, 139, 7, 9 |  | Off, On |  | Native Hawaiian |
| `Other_4` | text | 101, 91, 145, 12 |  |  |  | Other |
| `Check Box7` | checkbox | 487, 237, 9, 7 |  | Yes |  |  |
| `Check Box8` | checkbox | 519, 237, 9, 7 |  | Yes |  |  |

## Page 8

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `If no list address` | text | 42, 659, 301, 11 |  |  |  | If no, list address |
| `undefined_29` | checkbox | 381, 669, 7, 9 |  | Off, On |  | undefined |
| `undefined_30` | checkbox | 432, 669, 7, 9 |  | Off, On |  | undefined |
| `14 Is PERSON 2 pregnant` | radio | 181, 631, 7, 9 |  | Off, Yes_23 |  | 14. Is PERSON 2 pregnant |
| `14 Is PERSON 2 pregnant` | radio | 213, 632, 6, 8 |  | No_22, Off |  | 14. Is PERSON 2 pregnant |
| `If yes how many babies are expected during this pregnancy_2` | text | 518, 630, 37, 13 |  |  |  | If yes, how many babies are expected during this pregnancy |
| `Check Box13` | checkbox | 50, 578, 10, 10 |  | Off, Yes |  |  |
| `No_24` | checkbox | 105, 578, 7, 9 |  | Off, On |  | No |
| `Carolina` | radio | 375, 580, 7, 9 |  | Off, Yes_24 |  | Carolina |
| `Carolina` | radio | 433, 580, 7, 9 |  | No_23, Off |  | Carolina |
| `undefined_31` | checkbox | 65, 547, 7, 9 |  | Off, On |  | undefined |
| `undefined_32` | checkbox | 124, 547, 7, 9 |  | Off, On |  | undefined |
| `undefined_33` | checkbox | 451, 547, 7, 9 |  | Off, On |  | undefined |
| `undefined_34` | checkbox | 510, 547, 7, 9 |  | Off, On |  | undefined |
| `older` | radio | 285, 535, 7, 9 |  | Off, Yes_25 |  | older |
| `older` | radio | 344, 535, 7, 9 |  | No_25, Off |  | older |
| `living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and` | radio | 237, 494, 7, 9 |  | Off, Yes_26 |  | living (such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and` | radio | 297, 494, 7, 9 |  | No_26, Off |  | living (such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `19 Does PERSON 2 need help paying for medical bills in the last 3 months` | radio | 382, 476, 7, 9 |  | Off, Yes_27 |  | 19. Does PERSON 2 need help paying for medical bills in the last 3 months |
| `19 Does PERSON 2 need help paying for medical bills in the last 3 months` | radio | 423, 476, 7, 9 |  | No_27, Off |  | 19. Does PERSON 2 need help paying for medical bills in the last 3 months |
| `undefined_35` | checkbox | 433, 420, 7, 9 |  | Off, On |  | undefined |
| `No_28` | checkbox | 475, 419, 7, 9 |  | Off, On |  | No |
| `20 Did PERSON 2 have insurance through a job and lose it within the past 3 months` | text | 149, 405, 114, 13 |  |  |  | 20. Did PERSON 2 have insurance through a job and lose it within the past 3 months |
| `Yes_28` | text | 412, 405, 123, 13 |  |  |  | Yes |

## Page 9

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Employed_2` | checkbox | 61, 684, 11, 14 |  | Off, On |  | Employed |
| `SelfEmployed_2` | checkbox | 259, 684, 10, 14 |  | Off, On |  | Self-Employed |
| `Not employed_2` | checkbox | 412, 684, 11, 14 |  | Off, On |  | Not employed |
| `23 Employer phone number` | text | 434, 601, 143, 16 |  |  |  | 23. Employer phone number: ( ) - |
| `Hourly_3` | checkbox | 183, 578, 7, 9 |  | Off, On |  | Hourly |
| `Weekly_3` | checkbox | 229, 578, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks_3` | checkbox | 279, 578, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly_3` | checkbox | 357, 578, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly_3` | checkbox | 446, 578, 7, 9 |  | Off, On |  | Monthly |
| `Yearly_3` | checkbox | 499, 578, 7, 9 |  | Off, On |  | Yearly |
| `undefined_36` | text | 69, 563, 145, 13 |  |  |  | undefined |
| `25 Average hours worked each WEEK` | text | 219, 535, 151, 12 |  |  |  | 25. Average hours worked each WEEK |
| `26 Employer Name and Address` | text | 36, 447, 269, 16 |  |  |  | 26. Employer Name and Address |
| `27 Employer phone number` | text | 310, 447, 153, 12 |  |  |  | 27. Employer phone number: ( ) - |
| `Hourly_4` | checkbox | 176, 434, 7, 9 |  | Off, On |  | Hourly |
| `Weekly_4` | checkbox | 223, 434, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks_4` | checkbox | 274, 434, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly_4` | checkbox | 352, 434, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly_4` | checkbox | 439, 434, 7, 9 |  | Off, On |  | Monthly |
| `Yearly_4` | checkbox | 491, 434, 7, 9 |  | Off, On |  | Yearly |
| `undefined_37` | text | 60, 419, 178, 13 |  |  |  | undefined |
| `29 Average hours worked each WEEK` | text | 219, 391, 151, 12 |  |  |  | 29. Average hours worked each WEEK |
| `30 In the past year did PERSON 2` | text | 36, 374, 540, 13 |  |  |  | 30. In the past year, did PERSON 2 |
| `Change Jobs_2` | checkbox | 58, 348, 7, 9 |  | Off, On |  | Change Jobs |
| `Stop Working_2` | checkbox | 171, 348, 7, 9 |  | Off, On |  | Stop Working |
| `Start working fewer hours_2` | checkbox | 281, 348, 7, 9 |  | Off, On |  | Start working fewer hours |
| `None of these_2` | checkbox | 435, 348, 7, 9 |  | Off, On |  | None of these |
| `Type of work_2` | text | 139, 318, 167, 13 |  |  |  | Type of work |
| `month_2` | text | 113, 294, 167, 12 |  |  |  | month |
| `Net farmingfishing_2` | checkbox | 331, 222, 7, 9 |  | Off, On |  | Net farming/fishing |
| `Net rentalroyalty_2` | checkbox | 331, 206, 7, 9 |  | Off, On |  | Net rental/royalty |
| `Other income_2` | checkbox | 331, 191, 7, 9 |  | Off, On |  | Other income |
| `None_2` | checkbox | 61, 222, 7, 9 |  | Off, On |  | None |
| `Unemployment_2` | checkbox | 60, 206, 7, 9 |  | Off, On |  | Unemployment |
| `Pensions_2` | checkbox | 60, 191, 7, 9 |  | Off, On |  | Pensions |
| `Social Security_2` | checkbox | 60, 176, 7, 9 |  | Off, On |  | Social Security |
| `Retirement Accounts_2` | checkbox | 60, 160, 7, 9 |  | Off, On |  | Retirement Accounts |
| `Alimony Received_2` | checkbox | 61, 145, 7, 9 |  | Off, On |  | Alimony Received |
| `undefined_38` | text | 175, 223, 33, 13 |  |  |  | undefined |
| `How Often_12` | text | 261, 223, 42, 13 |  |  |  | How Often |
| `undefined_39` | text | 443, 222, 34, 13 |  |  |  | undefined |
| `How Often_13` | text | 529, 222, 42, 13 |  |  |  | How Often |
| `undefined_40` | text | 175, 207, 33, 13 |  |  |  | undefined |
| `How Often_14` | text | 262, 207, 42, 13 |  |  |  | How Often |
| `undefined_41` | text | 443, 206, 33, 13 |  |  |  | undefined |
| `How Often_15` | text | 529, 206, 42, 13 |  |  |  | How Often |
| `undefined_42` | text | 175, 192, 33, 13 |  |  |  | undefined |
| `How Often_16` | text | 261, 192, 42, 13 |  |  |  | How Often |
| `undefined_43` | text | 441, 191, 33, 13 |  |  |  | undefined |
| `How Often_17` | text | 527, 191, 42, 13 |  |  |  | How Often |
| `1_2` | text | 175, 177, 34, 13 |  |  |  | [1] |
| `2_2` | text | 176, 161, 34, 13 |  |  |  | [2] |
| `How Often_18` | text | 261, 177, 42, 13 |  |  |  | How Often |
| `Type_3` | text | 402, 178, 167, 12 |  |  |  | Type |
| `How Often_19` | text | 263, 161, 42, 13 |  |  |  | How Often |
| `undefined_44` | text | 176, 146, 33, 13 |  |  |  | undefined |
| `How Often_20` | text | 262, 146, 42, 13 |  |  |  | How Often |
| `Text6` | text | 42, 591, 389, 25 |  |  |  |  |

## Page 10

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Alimony Paid_2` | checkbox | 41, 681, 7, 9 |  | Off, On |  | Alimony Paid |
| `Student Loan Interest_2` | checkbox | 41, 668, 7, 9 |  | Off, On |  | Student Loan Interest |
| `Other Deductions_2` | checkbox | 41, 654, 7, 9 |  | Off, On |  | Other Deductions |
| `undefined_45` | text | 165, 680, 33, 12 |  |  |  | undefined |
| `How Often_21` | text | 248, 680, 48, 12 |  |  |  | How Often |
| `undefined_46` | text | 162, 666, 34, 12 |  |  |  | undefined |
| `How Often_22` | text | 246, 666, 48, 12 |  |  |  | How Often |
| `undefined_47` | text | 162, 653, 33, 12 |  |  |  | undefined |
| `How Often_23` | text | 245, 653, 48, 12 |  |  |  | How Often |
| `Type_4` | text | 334, 653, 112, 12 |  |  |  | Type |
| `undefined_48` | text | 230, 596, 95, 12 |  |  |  | undefined |
| `undefined_49` | text | 376, 584, 95, 12 |  |  |  | undefined |
| `PERSON 2s total income next year if you think it will be different` | text | 35, 571, 561, 12 |  |  |  | PERSON 2’s total income next year (if you think it will be different |

## Page 11

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Complete Step 2 for PERSON 3 their spouse their children under age 21 who live with them and anyone they claimed` | text | 35, 714, 540, 10 |  |  |  | Complete Step 2 for PERSON 3, their spouse, their children under age 21 who live with them and anyone they claimed |
| `1 First name Middle name Last name and Suffix_3` | text | 36, 655, 413, 15 |  |  |  | 1. First name, Middle name, Last name and Suffix |
| `2 Relationship to you_2` | text | 451, 655, 124, 15 |  |  |  | 2. Relationship to you: |
| `undefined_50` | text | 176, 644, 135, 10 |  |  |  | undefined |
| `3 Date of Birth mmddyyyy_3` | text | 36, 635, 297, 9 |  |  |  | 3. Date of Birth (mm/dd/yyyy): |
| `4 Sex Male Female_3` | text | 333, 635, 241, 9 |  |  |  | 4. Sex Male Female |
| `undefined_51` | checkbox | 381, 644, 7, 9 |  | Off, On |  | undefined |
| `undefined_52` | checkbox | 423, 644, 7, 9 |  | Off, On |  | undefined |
| `5 Social Security Number SSN_3` | text | 192, 624, 113, 10 |  |  |  | 5. Social Security Number (SSN |
| `Yes_29` | checkbox | 72, 570, 7, 9 |  | Off, On |  | Yes |
| `If yes please answer question ac_2` | radio | 306, 570, 7, 9 |  | No_29, Off |  | If yes, please answer question a-c |
| `If yes please answer question ac_2` | radio | 308, 545, 7, 9 |  | No_30, Off |  | If yes, please answer question a-c |
| `Yes_30` | checkbox | 273, 545, 7, 9 |  | Off, On |  | Yes |
| `If yes name of spouse_3` | text | 452, 544, 116, 10 |  |  |  | If yes, name of spouse |
| `Will PERSON 3 claim any dependents on their tax return` | radio | 337, 512, 7, 9 |  | Off, Yes_31 |  | Will PERSON 3 claim any dependents on their tax return |
| `Will PERSON 3 claim any dependents on their tax return` | radio | 369, 512, 7, 9 |  | No_31, Off |  | Will PERSON 3 claim any dependents on their tax return |
| `If yes list name s of dependents_3` | text | 231, 498, 162, 10 |  |  |  | If yes, list name (s) of dependents |
| `Will PERSON 3 be claimed as a dependent on someone elses tax return` | radio | 409, 466, 7, 9 |  | Off, Yes_32 |  | Will PERSON 3 be claimed as a dependent on someone else’s tax return |
| `Will PERSON 3 be claimed as a dependent on someone elses tax return` | radio | 445, 466, 7, 9 |  | No_32, Off |  | Will PERSON 3 be claimed as a dependent on someone else’s tax return |
| `If yes please list the name of the tax filer_3` | text | 258, 439, 274, 10 |  |  |  | If yes, please list the name of the tax filer |
| `Is PERSON 3 related to this tax filer If so how` | text | 289, 427, 241, 10 |  |  |  | Is PERSON 3 related to this tax filer? If so, how |
| `7_2` | text | 41, 417, 14, 9 |  |  |  | 7 |
| `Does PERSON 3 need health coverage` | text | 59, 417, 516, 9 |  |  |  | Does PERSON 3 need health coverage? |
| `Yes If yes answer all the questions below_3` | checkbox | 64, 376, 7, 9 |  | Off, On |  | Yes, If yes, answer all the questions below |
| `No If no SKIP to the income question on page 11 Leave the rest of this section blank` | checkbox | 64, 359, 7, 9 |  | Off, On |  | No, If no, SKIP to the income question on page 11. Leave the rest of this section blank |
| `Is PERSON 3 a US citizen or US National` | radio | 272, 337, 7, 9 |  | Off, Yes_33 |  | Is PERSON 3 a U.S. citizen or U.S. National |
| `Is PERSON 3 a US citizen or US National` | radio | 306, 337, 7, 9 |  | No_33, Off |  | Is PERSON 3 a U.S. citizen or U.S. National |
| `Yes Fill in their document type and ID number below_2` | checkbox | 57, 291, 7, 9 |  | Off, On |  | Yes. Fill in their document type and ID number below |
| `Immigration document type_3` | text | 202, 278, 90, 10 |  |  |  | Immigration document type |
| `Document ID number_3` | text | 177, 266, 112, 10 |  |  |  | Document ID number |
| `Date of entry into the US_3` | text | 197, 254, 90, 10 |  |  |  | Date of entry into the U.S |
| `Mexican_3` | checkbox | 57, 187, 7, 9 |  | Off, On |  | Mexican |
| `MexicanAmerican_3` | checkbox | 116, 187, 7, 9 |  | Off, On |  | Mexican-American |
| `Puerto Rican_3` | checkbox | 221, 187, 7, 9 |  | Off, On |  | Puerto Rican |
| `Cuban_3` | checkbox | 300, 187, 7, 9 |  | Off, On |  | Cuban |
| `Other_5` | checkbox | 346, 187, 7, 9 |  | Off, On |  | Other |
| `undefined_53` | text | 387, 186, 151, 10 |  |  |  | undefined |
| `White or Caucasian_3` | checkbox | 61, 155, 7, 9 |  | Off, On |  | White or Caucasian |
| `Other Pacific Islander_3` | checkbox | 60, 141, 7, 9 |  | Off, On |  | Other Pacific Islander |
| `American Indian or Alaska Native If so complete Appendix B_2` | checkbox | 61, 128, 7, 9 |  | Off, On |  | American Indian or Alaska Native (If so, complete Appendix B |
| `Other_6` | checkbox | 60, 114, 7, 9 |  | Off, On |  | Other |
| `Black or AfricanAmerican_3` | checkbox | 164, 155, 7, 9 |  | Off, On |  | Black or African-American |
| `Asian_3` | checkbox | 294, 155, 7, 9 |  | Off, On |  | Asian |
| `Native Hawaiian_3` | checkbox | 335, 155, 7, 9 |  | Off, On |  | Native Hawaiian |
| `undefined_54` | text | 101, 113, 145, 10 |  |  |  | undefined |
| `Check Box3` | checkbox | 487, 240, 9, 7 |  | Yes |  |  |
| `Check Box4` | checkbox | 519, 241, 9, 7 |  | Yes |  |  |

## Page 12

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `13 Is PERSON 3 a resident of North Carolina` | radio | 376, 691, 7, 9 |  | Off, Yes_36 |  | 13. Is PERSON 3 a resident of North Carolina |
| `13 Is PERSON 3 a resident of North Carolina` | radio | 428, 691, 7, 9 |  | No_36, Off |  | 13. Is PERSON 3 a resident of North Carolina |
| `If no list address_2` | text | 42, 679, 295, 11 |  |  |  | If no, list address |
| `14 Is PERSON 3 pregnant` | radio | 180, 660, 7, 9 |  | Off, Yes_37 |  | 14. Is PERSON 3 pregnant |
| `14 Is PERSON 3 pregnant` | radio | 212, 660, 6, 8 |  | No_37, Off |  | 14. Is PERSON 3 pregnant |
| `If yes how many babies are expected during this pregnancy_3` | text | 518, 659, 37, 11 |  |  |  | If yes, how many babies are expected during this pregnancy |
| `Check Box14` | checkbox | 50, 611, 10, 10 |  | Off, Yes |  |  |
| `No_39` | checkbox | 105, 612, 7, 9 |  | Off, On |  | No |
| `Carolina_2` | radio | 370, 611, 7, 9 |  | Off, Yes_38 |  | Carolina |
| `Carolina_2` | radio | 429, 611, 7, 9 |  | No_38, Off |  | Carolina |
| `undefined_55` | checkbox | 65, 584, 7, 9 |  | Off, On |  | undefined |
| `undefined_56` | checkbox | 124, 584, 7, 9 |  | Off, On |  | undefined |
| `undefined_57` | checkbox | 449, 584, 7, 9 |  | Off, On |  | undefined |
| `undefined_58` | checkbox | 508, 584, 7, 9 |  | Off, On |  | undefined |
| `older_2` | radio | 281, 572, 7, 9 |  | Off, Yes_39 |  | older |
| `older_2` | radio | 340, 572, 7, 9 |  | No_40, Off |  | older |
| `living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and_2` | radio | 235, 535, 7, 9 |  | Off, Yes_40 |  | living (such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and_2` | radio | 293, 535, 7, 9 |  | No_41, Off |  | living (such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `19 Does PERSON 3 need help paying for medical bills in the last 3 months` | radio | 382, 519, 7, 9 |  | Off, Yes_41 |  | 19. Does PERSON 3 need help paying for medical bills in the last 3 months |
| `19 Does PERSON 3 need help paying for medical bills in the last 3 months` | radio | 423, 519, 7, 9 |  | No_42, Off |  | 19. Does PERSON 3 need help paying for medical bills in the last 3 months |
| `undefined_59` | checkbox | 430, 464, 7, 9 |  | Off, On |  | undefined |
| `No_43` | checkbox | 472, 464, 7, 9 |  | Off, On |  | No |
| `20 Did PERSON 3 have insurance through a job and lose it within the past 3 months` | text | 152, 451, 114, 11 |  |  |  | 20. Did PERSON 3 have insurance through a job and lose it within the past 3 months |
| `Yes_42` | text | 415, 451, 123, 11 |  |  |  | Yes |

## Page 13

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Employed_3` | checkbox | 61, 684, 11, 14 |  | Off, On |  | Employed |
| `SelfEmployed_3` | checkbox | 259, 684, 10, 14 |  | Off, On |  | Self-Employed |
| `Not employed_3` | checkbox | 412, 684, 11, 14 |  | Off, On |  | Not employed |
| `23 Employer phone number_2` | text | 435, 605, 143, 14 |  |  |  | 23. Employer phone number: ( ) - |
| `Hourly_5` | checkbox | 183, 586, 7, 9 |  | Off, On |  | Hourly |
| `Weekly_5` | checkbox | 229, 586, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks_5` | checkbox | 278, 586, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly_5` | checkbox | 357, 586, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly_5` | checkbox | 443, 586, 7, 9 |  | Off, On |  | Monthly |
| `Yearly_5` | checkbox | 495, 586, 7, 9 |  | Off, On |  | Yearly |
| `undefined_60` | text | 69, 567, 145, 12 |  |  |  | undefined |
| `25 Average hours worked each WEEK_2` | text | 219, 543, 151, 12 |  |  |  | 25. Average hours worked each WEEK |
| `Hourly_6` | checkbox | 177, 441, 7, 9 |  | Off, On |  | Hourly |
| `Weekly_6` | checkbox | 222, 441, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks_6` | checkbox | 272, 441, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly_6` | checkbox | 353, 441, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly_6` | checkbox | 441, 441, 7, 9 |  | Off, On |  | Monthly |
| `Yearly_6` | checkbox | 493, 441, 7, 9 |  | Off, On |  | Yearly |
| `undefined_61` | text | 61, 428, 178, 11 |  |  |  | undefined |
| `29 Average hours worked each WEEK 1` | text | 219, 404, 151, 12 |  |  |  | 29. Average hours worked each WEEK [1] |
| `Change Jobs_3` | checkbox | 58, 359, 7, 9 |  | Off, On |  | Change Jobs |
| `Stop Working_3` | checkbox | 171, 359, 7, 9 |  | Off, On |  | Stop Working |
| `Start working fewer hours_3` | checkbox | 281, 359, 7, 9 |  | Off, On |  | Start working fewer hours |
| `None of these_3` | checkbox | 435, 359, 7, 9 |  | Off, On |  | None of these |
| `Type of work_3` | text | 140, 320, 167, 12 |  |  |  | Type of work |
| `month_3` | text | 114, 296, 167, 12 |  |  |  | month |
| `undefined_62` | text | 177, 224, 34, 12 |  |  |  | undefined |
| `How Often_24` | text | 264, 227, 35, 12 |  |  |  | How Often |
| `undefined_63` | text | 436, 227, 34, 12 |  |  |  | undefined |
| `How Often_25` | text | 530, 228, 39, 12 |  |  |  | How Often |
| `None_3` | checkbox | 61, 225, 7, 9 |  | Off, On |  | None |
| `Unemployment_3` | checkbox | 60, 211, 7, 9 |  | Off, On |  | Unemployment |
| `Pensions_3` | checkbox | 61, 198, 7, 9 |  | Off, On |  | Pensions |
| `Social Security_3` | checkbox | 61, 185, 7, 9 |  | Off, On |  | Social Security |
| `Retirement Accounts_3` | checkbox | 61, 171, 7, 9 |  | Off, On |  | Retirement Accounts |
| `Alimony Received_3` | checkbox | 60, 158, 7, 9 |  | Off, On |  | Alimony Received |
| `undefined_64` | text | 177, 211, 34, 12 |  |  |  | undefined |
| `How Often_26` | text | 265, 213, 35, 12 |  |  |  | How Often |
| `Net farmingfishing_3` | checkbox | 330, 225, 7, 9 |  | Off, On |  | Net farming/fishing |
| `Net rentalroyalty_3` | checkbox | 329, 211, 7, 9 |  | Off, On |  | Net rental/royalty |
| `Other income_3` | checkbox | 330, 198, 7, 9 |  | Off, On |  | Other income |
| `undefined_65` | text | 436, 200, 34, 12 |  |  |  | undefined |
| `How Often_27` | text | 530, 213, 39, 12 |  |  |  | How Often |
| `undefined_66` | text | 177, 198, 33, 12 |  |  |  | undefined |
| `How Often_28` | text | 264, 200, 35, 12 |  |  |  | How Often |
| `undefined_67` | text | 436, 213, 34, 12 |  |  |  | undefined |
| `How Often_29` | text | 530, 201, 39, 12 |  |  |  | How Often |
| `1_3` | text | 178, 184, 33, 12 |  |  |  | [1] |
| `2_3` | text | 178, 171, 34, 12 |  |  |  | [2] |
| `How Often_30` | text | 265, 186, 35, 12 |  |  |  | How Often |
| `Type_5` | text | 380, 186, 172, 11 |  |  |  | Type |
| `How Often_31` | text | 266, 172, 34, 12 |  |  |  | How Often |
| `undefined_68` | text | 179, 157, 33, 12 |  |  |  | undefined |
| `How Often_32` | text | 266, 158, 34, 12 |  |  |  | How Often |
| `Text7` | text | 36, 598, 394, 22 |  |  |  |  |
| `Text8` | text | 42, 454, 392, 20 |  |  |  |  |
| `Text9` | text | 440, 456, 114, 19 |  |  |  |  |

## Page 14

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `33 DEDUCTIONS Check all that apply and give the amount and how often you get it` | text | 36, 755, 560, 12 |  |  |  | 33. DEDUCTIONS: Check all that apply, and give the amount and how often you get it |
| `Alimony Paid_3` | checkbox | 41, 680, 7, 9 |  | Off, On |  | Alimony Paid |
| `Student Loan Interest_3` | checkbox | 41, 667, 7, 9 |  | Off, On |  | Student Loan Interest |
| `Other Deductions_3` | checkbox | 41, 654, 7, 9 |  | Off, On |  | Other Deductions |
| `undefined_69` | text | 165, 679, 33, 12 |  |  |  | undefined |
| `How Often_33` | text | 248, 679, 48, 12 |  |  |  | How Often |
| `undefined_70` | text | 162, 666, 34, 12 |  |  |  | undefined |
| `How Often_34` | text | 246, 666, 48, 12 |  |  |  | How Often |
| `undefined_71` | text | 162, 652, 33, 12 |  |  |  | undefined |
| `How Often_35` | text | 245, 652, 48, 12 |  |  |  | How Often |
| `Type_6` | text | 334, 652, 112, 12 |  |  |  | Type |
| `undefined_72` | text | 230, 595, 95, 12 |  |  |  | undefined |
| `undefined_73` | text | 376, 583, 123, 12 |  |  |  | undefined |
| `PERSON 3s total income next year if you think it will be different` | text | 35, 570, 561, 12 |  |  |  | PERSON 3’s total income next year (if you think it will be different |

## Page 15

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Complete Step 2 for PERSON 4 their spouse their children under age 21 who live with them and anyone they claimed` | text | 35, 714, 540, 10 |  |  |  | Complete Step 2 for PERSON 4, their spouse, their children under age 21 who live with them and anyone they claimed |
| `1 First name Middle name Last name and Suffix_4` | text | 36, 655, 413, 15 |  |  |  | 1. First name, Middle name, Last name and Suffix |
| `2 Relationship to you_3` | text | 451, 655, 124, 15 |  |  |  | 2. Relationship to you: |
| `undefined_74` | text | 176, 644, 135, 10 |  |  |  | undefined |
| `3 Date of Birth mmddyyyy_4` | text | 36, 635, 297, 9 |  |  |  | 3. Date of Birth (mm/dd/yyyy): |
| `4 Sex Male Female_4` | text | 333, 635, 241, 9 |  |  |  | 4. Sex Male Female |
| `undefined_75` | checkbox | 381, 644, 7, 9 |  | Off, On |  | undefined |
| `undefined_76` | checkbox | 423, 644, 7, 9 |  | Off, On |  | undefined |
| `5 Social Security Number SSN_4` | text | 192, 624, 113, 10 |  |  |  | 5. Social Security Number (SSN |
| `Yes_43` | checkbox | 72, 570, 7, 9 |  | Off, On |  | Yes |
| `If yes please answer question ac_3` | radio | 306, 570, 7, 9 |  | No_44, Off |  | If yes, please answer question a-c |
| `If yes please answer question ac_3` | radio | 308, 545, 7, 9 |  | No_45, Off |  | If yes, please answer question a-c |
| `Yes_44` | checkbox | 273, 545, 7, 9 |  | Off, On |  | Yes |
| `If yes name of spouse_4` | text | 452, 544, 116, 10 |  |  |  | If yes, name of spouse |
| `Will PERSON 4 claim any dependents on their tax return` | radio | 337, 512, 7, 9 |  | Off, Yes_45 |  | Will PERSON 4 claim any dependents on their tax return |
| `Will PERSON 4 claim any dependents on their tax return` | radio | 369, 512, 7, 9 |  | No_46, Off |  | Will PERSON 4 claim any dependents on their tax return |
| `If yes list name s of dependents_4` | text | 231, 498, 162, 10 |  |  |  | If yes, list name (s) of dependents |
| `Will PERSON 4 be claimed as a dependent on someone elses tax return` | radio | 409, 466, 7, 9 |  | Off, Yes_46 |  | Will PERSON 4 be claimed as a dependent on someone else’s tax return |
| `Will PERSON 4 be claimed as a dependent on someone elses tax return` | radio | 445, 466, 7, 9 |  | No_47, Off |  | Will PERSON 4 be claimed as a dependent on someone else’s tax return |
| `If yes please list the name of the tax filer_4` | text | 258, 452, 274, 10 |  |  |  | If yes, please list the name of the tax filer |
| `Is PERSON 4 related to this tax filer If so how` | text | 289, 439, 241, 10 |  |  |  | Is PERSON 4 related to this tax filer? If so, how |
| `7_3` | text | 41, 429, 14, 9 |  |  |  | 7 |
| `Does PERSON 4 need health coverage` | text | 59, 429, 516, 9 |  |  |  | Does PERSON 4 need health coverage? |
| `Yes If yes answer all the questions below_4` | checkbox | 64, 387, 7, 9 |  | Off, On |  | Yes, If yes, answer all the questions below |
| `No If no SKIP to the income question on page 14 Leave the rest of this section blank` | checkbox | 64, 372, 7, 9 |  | Off, On |  | No, If no, SKIP to the income question on page 14. Leave the rest of this section blank |
| `Is PERSON 4 a US citizen or US National` | radio | 272, 350, 7, 9 |  | Off, Yes_47 |  | Is PERSON 4 a U.S. citizen or U.S. National |
| `Is PERSON 4 a US citizen or US National` | radio | 306, 350, 7, 9 |  | No_48, Off |  | Is PERSON 4 a U.S. citizen or U.S. National |
| `Yes Fill in their document type and ID number below_3` | checkbox | 57, 304, 7, 9 |  | Off, On |  | Yes. Fill in their document type and ID number below |
| `Immigration document type_4` | text | 202, 291, 90, 10 |  |  |  | Immigration document type |
| `Document ID number_4` | text | 177, 278, 112, 10 |  |  |  | Document ID number |
| `Date of entry into the US_4` | text | 197, 266, 90, 10 |  |  |  | Date of entry into the U.S |
| `Mexican_4` | checkbox | 57, 199, 7, 9 |  | Off, On |  | Mexican |
| `MexicanAmerican_4` | checkbox | 116, 199, 7, 9 |  | Off, On |  | Mexican-American |
| `Puerto Rican_4` | checkbox | 221, 199, 7, 9 |  | Off, On |  | Puerto Rican |
| `Cuban_4` | checkbox | 300, 199, 7, 9 |  | Off, On |  | Cuban |
| `Other_7` | checkbox | 346, 199, 7, 9 |  | Off, On |  | Other |
| `undefined_77` | text | 387, 198, 151, 10 |  |  |  | undefined |
| `White or Caucasian_4` | checkbox | 61, 168, 7, 9 |  | Off, On |  | White or Caucasian |
| `Other Pacific Islander_4` | checkbox | 60, 154, 7, 9 |  | Off, On |  | Other Pacific Islander |
| `American Indian or Alaska Native If so complete Appendix B_3` | checkbox | 61, 140, 7, 9 |  | Off, On |  | American Indian or Alaska Native (If so, complete Appendix B |
| `Other_8` | checkbox | 60, 127, 7, 9 |  | Off, On |  | Other |
| `Black or AfricanAmerican_4` | checkbox | 164, 168, 7, 9 |  | Off, On |  | Black or African-American |
| `Asian_4` | checkbox | 294, 168, 7, 9 |  | Off, On |  | Asian |
| `Native Hawaiian_4` | checkbox | 335, 168, 7, 9 |  | Off, On |  | Native Hawaiian |
| `undefined_78` | text | 101, 126, 145, 10 |  |  |  | undefined |
| `Check Box1` | checkbox | 487, 253, 9, 7 |  | Yes |  |  |
| `Check Box2` | checkbox | 521, 253, 9, 7 |  | Yes |  |  |

## Page 16

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `13 Is PERSON 4 a resident of North Carolina` | radio | 376, 691, 7, 9 |  | Off, Yes_50 |  | 13. Is PERSON 4 a resident of North Carolina |
| `13 Is PERSON 4 a resident of North Carolina` | radio | 428, 691, 7, 9 |  | No_51, Off |  | 13. Is PERSON 4 a resident of North Carolina |
| `If no list address_3` | text | 42, 679, 295, 11 |  |  |  | If no, list address |
| `14 Is PERSON 4 pregnant` | radio | 180, 660, 7, 9 |  | Off, Yes_51 |  | 14. Is PERSON 4 pregnant |
| `14 Is PERSON 4 pregnant` | radio | 212, 660, 6, 8 |  | No_52, Off |  | 14. Is PERSON 4 pregnant |
| `If yes how many babies are expected during this pregnancy_4` | text | 518, 659, 37, 11 |  |  |  | If yes, how many babies are expected during this pregnancy |
| `Check Box15` | checkbox | 44, 610, 13, 12 |  | Off, Yes |  |  |
| `undefined_79` | checkbox | 105, 612, 7, 9 |  | On |  | undefined |
| `undefined_80` | checkbox | 370, 611, 7, 9 |  | Off, On |  | undefined |
| `undefined_81` | checkbox | 429, 611, 7, 9 |  | Off, On |  | undefined |
| `undefined_82` | checkbox | 65, 569, 7, 9 |  | Off, On |  | undefined |
| `undefined_83` | checkbox | 124, 569, 7, 9 |  | Off, On |  | undefined |
| `undefined_84` | checkbox | 449, 569, 7, 9 |  | Off, On |  | undefined |
| `undefined_85` | checkbox | 508, 569, 7, 9 |  | Off, On |  | undefined |
| `older_3` | radio | 281, 557, 7, 9 |  | Off, Yes_52 |  | older |
| `older_3` | radio | 340, 557, 7, 9 |  | No_53, Off |  | older |
| `living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and_3` | radio | 239, 520, 7, 9 |  | Off, Yes_53 |  | living (such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and_3` | radio | 298, 520, 7, 9 |  | No_54, Off |  | living (such as bathing, dressing, daily chores, etc.), live in a medical facility, nursing home and/or need home and |
| `Check Box17` | checkbox | 378, 504, 9, 11 |  | Off, Yes |  |  |
| `Check Box18` | checkbox | 419, 504, 9, 10 |  | Off, Yes |  |  |
| `undefined_86` | checkbox | 430, 449, 7, 9 |  | Off, On |  | undefined |
| `No_56` | checkbox | 472, 449, 7, 9 |  | Off, On |  | No |
| `20 Did PERSON 4 have insurance through a job and lose it within the past 3 months` | text | 145, 436, 114, 11 |  |  |  | 20. Did PERSON 4 have insurance through a job and lose it within the past 3 months |
| `Yes_55` | text | 406, 437, 124, 11 |  |  |  | Yes |

## Page 17

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Employed_4` | checkbox | 61, 684, 11, 14 |  | Off, On |  | Employed |
| `SelfEmployed_4` | checkbox | 259, 684, 10, 14 |  | Off, On |  | Self-Employed |
| `Not employed_4` | checkbox | 412, 684, 11, 14 |  | Off, On |  | Not employed |
| `23 Employer phone number_3` | text | 436, 608, 143, 14 |  |  |  | 23. Employer phone number: ( ) - |
| `Hourly_7` | checkbox | 183, 586, 7, 9 |  | On |  | Hourly |
| `Weekly_7` | checkbox | 231, 586, 5, 9 |  | On |  | Weekly |
| `Every 2 weeks_7` | checkbox | 279, 586, 7, 9 |  | On |  | Every 2 weeks |
| `Twice a Monthly_7` | checkbox | 358, 586, 7, 9 |  | On |  | Twice a Monthly |
| `Monthly_7` | checkbox | 444, 586, 7, 9 |  | On |  | Monthly |
| `Yearly_7` | checkbox | 496, 586, 7, 9 |  | On |  | Yearly |
| `undefined_87` | text | 69, 567, 145, 12 |  |  |  | undefined |
| `25 Average hours worked each WEEK_3` | text | 219, 543, 151, 12 |  |  |  | 25. Average hours worked each WEEK |
| `Hourly_8` | checkbox | 177, 441, 7, 9 |  | Off, On |  | Hourly |
| `Weekly_8` | checkbox | 222, 441, 7, 9 |  | Off, On |  | Weekly |
| `Every 2 weeks_8` | checkbox | 273, 441, 7, 9 |  | Off, On |  | Every 2 weeks |
| `Twice a Monthly_8` | checkbox | 355, 441, 7, 9 |  | Off, On |  | Twice a Monthly |
| `Monthly_8` | checkbox | 444, 441, 7, 9 |  | Off, On |  | Monthly |
| `Yearly_8` | checkbox | 496, 441, 7, 9 |  | Off, On |  | Yearly |
| `undefined_88` | text | 61, 428, 178, 11 |  |  |  | undefined |
| `29 Average hours worked each WEEK 1_2` | text | 219, 404, 151, 12 |  |  |  | 29. Average hours worked each WEEK [1] |
| `Change Jobs_4` | checkbox | 58, 359, 7, 9 |  | Off, On |  | Change Jobs |
| `Stop Working_4` | checkbox | 171, 359, 7, 9 |  | Off, On |  | Stop Working |
| `Start working fewer hours_4` | checkbox | 281, 359, 7, 9 |  | Off, On |  | Start working fewer hours |
| `None of these_4` | checkbox | 435, 359, 7, 9 |  | Off, On |  | None of these |
| `a Type of work` | text | 133, 320, 167, 12 |  |  |  | a. Type of work |
| `month_4` | text | 98, 296, 161, 12 |  |  |  | month |
| `undefined_89` | text | 177, 239, 34, 12 |  |  |  | undefined |
| `How Often_36` | text | 264, 239, 37, 12 |  |  |  | How Often |
| `None_4` | checkbox | 60, 236, 7, 9 |  | Off, On |  | None |
| `Unemployment_4` | checkbox | 59, 223, 7, 9 |  | Off, On |  | Unemployment |
| `Pensions_4` | checkbox | 60, 209, 7, 9 |  | Off, On |  | Pensions |
| `Social Security_4` | checkbox | 60, 196, 7, 9 |  | Off, On |  | Social Security |
| `Retirement Accounts_4` | checkbox | 59, 183, 7, 9 |  | Off, On |  | Retirement Accounts |
| `Alimony Received_4` | checkbox | 58, 169, 7, 9 |  | Off, On |  | Alimony Received |
| `Net farmingfishing_4` | checkbox | 333, 237, 7, 9 |  | Off, On |  | Net farming/fishing |
| `undefined_90` | text | 446, 238, 34, 12 |  |  |  | undefined |
| `How Often_37` | text | 529, 237, 42, 12 |  |  |  | How Often |
| `undefined_91` | text | 177, 224, 34, 12 |  |  |  | undefined |
| `How Often_38` | text | 264, 226, 37, 12 |  |  |  | How Often |
| `Net rentalroyalty_4` | checkbox | 336, 221, 7, 13 |  | On |  | Net rental/royalty |
| `Other income_4` | checkbox | 336, 210, 7, 9 |  | Off, On |  | Other income |
| `undefined_92` | text | 441, 224, 34, 12 |  |  |  | undefined |
| `How Often_39` | text | 529, 225, 42, 12 |  |  |  | How Often |
| `undefined_93` | text | 177, 208, 33, 12 |  |  |  | undefined |
| `How Often_40` | text | 264, 212, 37, 12 |  |  |  | How Often |
| `undefined_94` | text | 443, 210, 33, 12 |  |  |  | undefined |
| `How Often_41` | text | 528, 211, 42, 12 |  |  |  | How Often |
| `1_4` | text | 177, 195, 33, 12 |  |  |  | [1] |
| `2_4` | text | 177, 181, 34, 12 |  |  |  | [2] |
| `How Often_42` | text | 264, 199, 37, 12 |  |  |  | How Often |
| `Type_7` | text | 382, 199, 167, 11 |  |  |  | Type |
| `How Often_43` | text | 265, 183, 36, 12 |  |  |  | How Often |
| `undefined_95` | text | 178, 168, 33, 12 |  |  |  | undefined |
| `How Often_44` | text | 265, 169, 36, 12 |  |  |  | How Often |
| `Text10` | text | 440, 455, 128, 18 |  |  |  |  |
| `Text11` | text | 39, 597, 387, 21 |  |  |  |  |
| `Text12` | text | 42, 453, 391, 22 |  |  |  |  |

## Page 18

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `Alimony Paid_4` | checkbox | 41, 681, 7, 9 |  | Off, On |  | Alimony Paid |
| `undefined_96` | text | 165, 680, 33, 12 |  |  |  | undefined |
| `How Often_45` | text | 248, 680, 48, 12 |  |  |  | How Often |
| `Student Loan Interest_4` | checkbox | 41, 668, 7, 9 |  | Off, On |  | Student Loan Interest |
| `undefined_97` | text | 162, 666, 34, 12 |  |  |  | undefined |
| `How Often_46` | text | 246, 666, 48, 12 |  |  |  | How Often |
| `Other Deductions_4` | checkbox | 41, 654, 7, 9 |  | Off, On |  | Other Deductions |
| `undefined_98` | text | 162, 653, 33, 12 |  |  |  | undefined |
| `How Often_47` | text | 245, 653, 48, 12 |  |  |  | How Often |
| `Type_8` | text | 334, 653, 112, 12 |  |  |  | Type |
| `undefined_99` | text | 230, 596, 95, 12 |  |  |  | undefined |
| `undefined_100` | text | 376, 584, 95, 12 |  |  |  | undefined |
| `PERSON 4s total income next year if you think it will be different` | text | 35, 571, 561, 12 |  |  |  | PERSON 4’s total income next year (if you think it will be different |

## Page 19

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `If yes complete Appendix B` | checkbox | 47, 655, 7, 9 |  | Off, On |  | If yes, complete Appendix B |
| `If no complete Step 4` | checkbox | 47, 641, 7, 9 |  | Off, On |  | If no, complete Step 4 |
| `Is anyone enrolled in health coverage now from the following` | radio | 78, 549, 7, 9 |  | Off, Yes_56 |  | Is anyone enrolled in health coverage now from the following |
| `Is anyone enrolled in health coverage now from the following` | radio | 138, 549, 7, 9 |  | No_57, Off |  | Is anyone enrolled in health coverage now from the following |
| `If yes check the type of coverage and write the persons names next to the coverage they have` | text | 98, 500, 145, 11 |  |  |  | If yes, check the type of coverage and write the person(s) name(s) next to the coverage they have |
| `Medicaid` | checkbox | 42, 501, 7, 9 |  | Off, On |  | Medicaid |
| `NC Health Choice NCHC` | checkbox | 42, 488, 7, 9 |  | Off, On |  | N.C. Health Choice (NCHC |
| `Medicare` | checkbox | 42, 474, 7, 9 |  | Off, On |  | Medicare |
| `TRICARE Dont check if you have Direct Care or Line of Duty` | checkbox | 42, 461, 7, 9 |  | Off, On |  | TRICARE (Don’t check if you have Direct Care or Line of Duty |
| `VA health care programs` | checkbox | 42, 448, 7, 9 |  | Off, On |  | VA health care programs |
| `Peace Corps` | checkbox | 42, 434, 7, 9 |  | Off, On |  | Peace Corps |
| `undefined_101` | text | 180, 487, 68, 11 |  |  |  | undefined |
| `undefined_102` | text | 100, 473, 145, 11 |  |  |  | undefined |
| `undefined_103` | text | 168, 447, 73, 11 |  |  |  | undefined |
| `undefined_104` | text | 115, 433, 123, 11 |  |  |  | undefined |
| `Other_9` | checkbox | 330, 409, 7, 9 |  | Off, On |  | Other |
| `undefined_105` | text | 371, 408, 178, 11 |  |  |  | undefined |
| `Insurance` | text | 529, 385, 23, 11 |  |  |  | Insurance |
| `Policy Number` | text | 400, 374, 151, 11 |  |  |  | Policy Number |
| `Type of Coverage` | text | 414, 362, 134, 11 |  |  |  | Type of Coverage |
| `someone elses job such as a parent or spouse` | radio | 78, 307, 7, 9 |  | Off, Yes_57 |  | someone else’s job, such as a parent or spouse |
| `someone elses job such as a parent or spouse` | radio | 79, 293, 7, 9 |  | No_58, Off |  | someone else’s job, such as a parent or spouse |
| `Have you or anyone requesting assistance been in an accident in the past 12 months` | radio | 387, 247, 7, 9 |  | Off, Yes_58 |  | Have you or anyone requesting assistance been in an accident in the past 12 months |
| `Have you or anyone requesting assistance been in an accident in the past 12 months` | radio | 422, 247, 7, 9 |  | No_59, Off |  | Have you or anyone requesting assistance been in an accident in the past 12 months |
| `undefined_106` | radio | 446, 270, 7, 9 |  | Off, Yes_59 |  | undefined |
| `undefined_106` | radio | 481, 270, 7, 9 |  | No_60, Off |  | undefined |

## Page 20

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `5 years the maximum number of years allowed` | checkbox | 56, 480, 6, 8 |  | Off, On |  | 5 years (the maximum number of years allowed |
| `4 years` | checkbox | 276, 480, 6, 8 |  | Off, On |  | 4 years |
| `3 years` | checkbox | 320, 480, 6, 8 |  | Off, On |  | 3 years |
| `2 year` | checkbox | 364, 480, 6, 8 |  | Off, On |  | 2 year |
| `1 year` | checkbox | 402, 480, 6, 8 |  | Off, On |  | 1 year |
| `Do not use information from tax returns to renew my coverage` | checkbox | 56, 468, 6, 8 |  | Off, On |  | Do not use information from tax returns to renew my coverage |
| `Signature` | text | 46, 80, 396, 18 |  |  |  | Signature |
| `Date mmddyyyy` | text | 444, 80, 142, 18 |  |  |  | Date (mm/dd/yyyy) |

## Page 21

| field name | type | rect x,y,w,h | read-only | export values / options | value | printed label (tooltip) |
|---|---|---|---|---|---|---|
| `If you are NOT registered to vote where you live now would you like to register to vote here today_2` | radio | 46, 640, 5, 7 |  | Off, Yes_60 |  | If you are NOT registered to vote where you live now, would you like to register to vote here today |
| `If you are NOT registered to vote where you live now would you like to register to vote here today_2` | radio | 72, 640, 5, 7 |  | No_61, Off |  | If you are NOT registered to vote where you live now, would you like to register to vote here today |
