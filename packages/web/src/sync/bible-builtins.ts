// The built-in templates and fields, copied from the sample library fixture (Spec/fixtures/archives/valid/sample-library/bible/).
// The spec does not say how a library gets its built-in templates. This client creates them through sync when the story
// bible is first opened, only for what is missing (see seedOps in bible.ts). Same ids and values as the fixture.
// Fields exist in the fixture only for the character, location and term templates.

export const BUILTIN_TEMPLATES: readonly Record<string, unknown>[] = [
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "character",
    "id": "80000001-0000-4000-8000-000000000001",
    "name": "Character",
    "orderKey": "3a",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "location",
    "id": "80000002-0000-4000-8000-000000000002",
    "name": "Location",
    "orderKey": "6j",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "organization",
    "id": "80000003-0000-4000-8000-000000000003",
    "name": "Organization",
    "orderKey": "9t",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "object",
    "id": "80000004-0000-4000-8000-000000000004",
    "name": "Object",
    "orderKey": "d3",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "event",
    "id": "80000005-0000-4000-8000-000000000005",
    "name": "Event",
    "orderKey": "gd",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "plotline",
    "id": "80000006-0000-4000-8000-000000000006",
    "name": "Plotline",
    "orderKey": "jm",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "worldRule",
    "id": "80000007-0000-4000-8000-000000000007",
    "name": "WorldRule",
    "orderKey": "mw",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "research",
    "id": "80000008-0000-4000-8000-000000000008",
    "name": "Research",
    "orderKey": "q6",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "builtIn": true,
    "createdAt": "2026-11-02T12:00:00Z",
    "entryType": "term",
    "id": "80000009-0000-4000-8000-000000000009",
    "name": "Term",
    "orderKey": "tg",
    "updatedAt": "2026-11-02T12:00:00Z"
  }
];

export const BUILTIN_FIELDS: readonly Record<string, unknown>[] = [
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "shortText",
    "id": "90000001-0000-4000-8000-000000000001",
    "key": "role",
    "label": "Role",
    "orderKey": "0w",
    "required": true,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "longText",
    "id": "90000002-0000-4000-8000-000000000002",
    "key": "biography",
    "label": "Biography",
    "orderKey": "1r",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "integer",
    "id": "90000003-0000-4000-8000-000000000003",
    "key": "age",
    "label": "Age",
    "orderKey": "2n",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "decimal",
    "id": "90000004-0000-4000-8000-000000000004",
    "key": "heightMetres",
    "label": "Height (m)",
    "orderKey": "3i",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "boolean",
    "id": "90000005-0000-4000-8000-000000000005",
    "key": "alive",
    "label": "Alive",
    "orderKey": "4e",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "selection",
    "id": "90000006-0000-4000-8000-000000000006",
    "key": "temperament",
    "label": "Temperament",
    "multiple": true,
    "options": [
      {
        "id": "a0000258-0000-4000-8000-000000000258",
        "label": "Patient"
      },
      {
        "id": "a0000259-0000-4000-8000-000000000259",
        "label": "Stubborn"
      },
      {
        "id": "a000025a-0000-4000-8000-00000000025a",
        "label": "Curious"
      }
    ],
    "orderKey": "5a",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "fictionalDate",
    "id": "90000007-0000-4000-8000-000000000007",
    "key": "born",
    "label": "Born",
    "orderKey": "65",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "realDate",
    "id": "90000008-0000-4000-8000-000000000008",
    "key": "birthday",
    "label": "Birthday (real world)",
    "orderKey": "71",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "entryReference",
    "id": "90000009-0000-4000-8000-000000000009",
    "key": "home",
    "label": "Home",
    "orderKey": "7w",
    "required": false,
    "targetEntryTypes": [
      "location"
    ],
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "entryReferences",
    "id": "9000000a-0000-4000-8000-00000000000a",
    "key": "allies",
    "label": "Allies",
    "orderKey": "8s",
    "required": false,
    "targetEntryTypes": [
      "character"
    ],
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "attachment",
    "id": "9000000b-0000-4000-8000-00000000000b",
    "key": "portrait",
    "label": "Portrait",
    "orderKey": "9n",
    "required": false,
    "templateId": "80000001-0000-4000-8000-000000000001",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "selection",
    "id": "9000000c-0000-4000-8000-00000000000c",
    "key": "climate",
    "label": "Climate",
    "options": [
      {
        "id": "a00004b0-0000-4000-8000-0000000004b0",
        "label": "Temperate"
      },
      {
        "id": "a00004b1-0000-4000-8000-0000000004b1",
        "label": "Maritime"
      }
    ],
    "orderKey": "aj",
    "required": false,
    "templateId": "80000002-0000-4000-8000-000000000002",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "longText",
    "id": "90000019-0000-4000-8000-000000000019",
    "key": "meaning",
    "label": "Meaning",
    "orderKey": "ly",
    "required": false,
    "templateId": "80000009-0000-4000-8000-000000000009",
    "updatedAt": "2026-11-02T12:00:00Z"
  },
  {
    "createdAt": "2026-11-02T12:00:00Z",
    "fieldType": "shortText",
    "id": "9000001a-0000-4000-8000-00000000001a",
    "key": "pronunciation",
    "label": "Pronunciation",
    "orderKey": "mt",
    "required": false,
    "templateId": "80000009-0000-4000-8000-000000000009",
    "updatedAt": "2026-11-02T12:00:00Z"
  }
];
