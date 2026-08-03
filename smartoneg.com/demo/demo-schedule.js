// Real Shabbos / Yom Tov scenes + schedules, exported from the author's live
// SmartOneg instance and used verbatim as the demo base — a far more realistic
// timeline than a hand-written factory. ONLY scenes + schedules are copied here;
// location, notification, and integration settings are NOT (see demo-seed.js).
// demo-seed.js layers the multi-source devices (Hubitat / Home Assistant fridge,
// RGB, warm-cool color temperature, vacuum, etc.) and their rules on top.

export const SCENES = [
  {
    "id": "6o-F8q8q",
    "name": "Erev Shabbos (Friday night)",
    "extends": null,
    "actions": [
      {
        "zone": 4,
        "level": 100
      },
      {
        "zone": 9,
        "level": 0
      },
      {
        "zone": 10,
        "level": 100
      },
      {
        "zone": 2,
        "level": 100
      },
      {
        "zone": 3,
        "level": 100
      },
      {
        "zone": 8,
        "level": 65
      },
      {
        "zone": 7,
        "level": 0
      },
      {
        "zone": 5,
        "level": 0
      },
      {
        "zone": 12,
        "level": 100
      }
    ],
    "endActions": [
      {
        "zone": 4,
        "level": 0
      },
      {
        "zone": 10,
        "level": 80
      },
      {
        "zone": 3,
        "level": 0
      },
      {
        "zone": 8,
        "level": 0
      },
      {
        "zone": 7,
        "level": 0
      },
      {
        "zone": 5,
        "level": 30
      }
    ]
  },
  {
    "id": "BtaJ8wJo",
    "name": "Erev Yom Tov",
    "extends": "6o-F8q8q",
    "overrides": {
      "5": {
        "level": 100
      },
      "7": {
        "level": 100
      },
      "9": {
        "level": 100
      },
      "10": {
        "level": 0
      }
    },
    "add": [],
    "remove": [],
    "endActions": [
      {
        "zone": 4,
        "level": 0
      },
      {
        "zone": 3,
        "level": 0
      },
      {
        "zone": 8,
        "level": 0
      },
      {
        "zone": 5,
        "level": 30
      },
      {
        "zone": 7,
        "level": 0
      },
      {
        "zone": 10,
        "level": 80
      }
    ]
  },
  {
    "id": "6ws3_IHC",
    "name": "Day Mealtime",
    "extends": null,
    "actions": [
      {
        "zone": 3,
        "level": 100
      },
      {
        "zone": 7,
        "level": 100
      }
    ],
    "endActions": [
      {
        "zone": 3,
        "level": 0
      },
      {
        "zone": 7,
        "level": 0
      }
    ]
  },
  {
    "id": "RM_Oig3S",
    "name": "Shabbos & YT Morning",
    "extends": null,
    "actions": [
      {
        "zone": 2,
        "level": 100
      },
      {
        "zone": 4,
        "level": 100
      },
      {
        "zone": 10,
        "level": 100
      },
      {
        "zone": 8,
        "level": 100
      }
    ],
    "endActions": []
  },
  {
    "id": "PkhHgqv-",
    "name": "Motzei Shabbos & YT",
    "extends": null,
    "actions": [
      {
        "zone": 9,
        "level": 100
      },
      {
        "zone": 10,
        "level": 0
      },
      {
        "zone": 8,
        "level": 0
      }
    ]
  },
  {
    "id": "i-r4zYqV",
    "name": "Late Shabbos (or last day YT) Afternoon",
    "extends": null,
    "actions": [
      {
        "zone": 4,
        "level": 100
      },
      {
        "zone": 5,
        "level": 100
      }
    ]
  },
  {
    "id": "jxI28eiw",
    "name": "Day Mealtime - Yom Tov",
    "extends": "6ws3_IHC",
    "overrides": {},
    "add": [
      {
        "zone": 9,
        "level": 100
      },
      {
        "zone": 10,
        "level": 0
      },
      {
        "zone": 4,
        "level": 100
      }
    ],
    "remove": [],
    "endActions": [
      {
        "zone": 3,
        "level": 0
      },
      {
        "zone": 7,
        "level": 0
      },
      {
        "zone": 9,
        "level": 0
      },
      {
        "zone": 10,
        "level": 100
      }
    ]
  },
  {
    "id": "lp6Yt4Hd",
    "name": "Yom Tov - (Candle Lighting) Tzais Reminder",
    "extends": null,
    "actions": [
      {
        "zone": 9,
        "flash": 2
      },
      {
        "zone": 7,
        "flash": 2
      }
    ],
    "endActions": []
  },
  {
    "id": "X3wOusUc",
    "name": "Late night off",
    "extends": null,
    "actions": [
      {
        "zone": 2,
        "level": 0
      },
      {
        "zone": 5,
        "level": 0
      },
      {
        "zone": 10,
        "level": 25
      }
    ]
  }
];

export const SCHEDULES = {
  "shabbos": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before Shabbos starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:00",
                  "day": "erev"
                },
                "then": {
                  "kind": "fixed",
                  "time": "18:00",
                  "day": "erev"
                }
              }
            ]
          },
          "id": "7uit7rzg"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "uZeUuelR"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "hJ47h9rO"
        },
        {
          "label": "Den on",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "74P48tDn"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "LkZ1XdkA"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "KhUhjoEP"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "8E6NEbc0"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "6ws3_IHC"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "fku36jFH"
        },
        {
          "label": "Mincha Reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 3,
            "seconds": 2,
            "zones": [
              3,
              7
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "14:10",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "HMWnbnt7"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "6ws3_IHC"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "lfGdnied"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "X7iZrUXP"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -30
                }
              }
            ]
          },
          "id": "gNMv4kqe"
        },
        {
          "label": "End of Shabbos",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": []
          },
          "id": "zAp-_kVg"
        }
      ]
    },
    "follows-yt": {
      "rules": [
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "fku36jFH",
          "id": "wX8B38ni"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "lfGdnied",
          "id": "hvQmxewl"
        }
      ],
      "inheritsRegular": true,
      "removedIds": [
        "uZeUuelR"
      ]
    },
    "erev-pesach": {
      "rules": [
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "6ws3_IHC"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "fku36jFH",
          "id": "4ylXyGwT"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "6ws3_IHC"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "lfGdnied",
          "id": "hO_j6hPw"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": []
          },
          "overridesId": "X7iZrUXP",
          "id": "Cx9wYGmN"
        }
      ],
      "inheritsRegular": true,
      "removedIds": [
        "zAp-_kVg",
        "gNMv4kqe",
        "HMWnbnt7"
      ]
    },
    "guest": {
      "rules": [
        {
          "id": "rmssl0fvi1",
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 7,
            "level": 100,
            "fadeSec": 0,
            "zones": [
              7
            ]
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:00",
                  "day": "erev"
                },
                "then": {
                  "kind": "fixed",
                  "time": "18:00",
                  "day": "erev"
                }
              }
            ],
            "nextDay": false
          }
        },
        {
          "id": "rmso3l9vu0",
          "label": "Guest: Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "zones": [
              8
            ],
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          }
        },
        {
          "label": "Guest: Main Kitchen Lights ON",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 9,
            "level": 100,
            "fadeSec": 0,
            "zones": [
              9
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:15",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "W-4TmeaZ"
        },
        {
          "label": "Guest: Secondary Lights OFF",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 10,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              10
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:15",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "K0V8bENr"
        },
        {
          "id": "rmsvnwe6l0",
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 9,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              9
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmsvnwsuk2",
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 10,
            "zones": [
              10
            ],
            "level": 100,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    },
    "leads-into-yt": {
      "rules": [
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "rmsw7zj0j6",
          "overridesId": "fku36jFH"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "rmsw7zmv87",
          "overridesId": "lfGdnied"
        }
      ],
      "inheritsRegular": true,
      "removedIds": [
        "zAp-_kVg",
        "gNMv4kqe",
        "HMWnbnt7",
        "uZeUuelR",
        "hJ47h9rO"
      ]
    },
    "chol-hamoed-pesach": {
      "rules": [
        {
          "label": "5 min before Tzeis reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "overridesId": "uZeUuelR",
          "id": "N1k-cnEH"
        },
        {
          "label": "Tzeis reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "overridesId": "hJ47h9rO",
          "id": "7ZSFk8up"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "fku36jFH",
          "id": "qW-7TLe_"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "lfGdnied",
          "id": "G8qZN65O"
        }
      ],
      "inheritsRegular": true,
      "removedIds": []
    },
    "chol-hamoed-sukkos": {
      "rules": [
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "fku36jFH",
          "id": "2LHsBfDi"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "overridesId": "lfGdnied",
          "id": "yqnbYcX3"
        }
      ],
      "inheritsRegular": true,
      "removedIds": []
    }
  },
  "pesach-2": {
    "default": {
      "rules": [
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "p4MIt5NV"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "Q9gYQKjq"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "AkIqhuXa"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "mGoJT2fC"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          },
          "id": "hKSiHwIJ"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "KQgnsoPH"
        }
      ]
    },
    "leads-into-shabbos": {
      "rules": [],
      "inheritsRegular": true,
      "removedIds": [
        "KQgnsoPH",
        "hKSiHwIJ"
      ]
    },
    "guest": {
      "rules": [
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "P3ph7g2X"
        }
      ]
    }
  },
  "pesach-1": {
    "guest": {
      "rules": [
        {
          "label": "Guest: Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "zones": [
              8
            ],
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "_e5KqtQv"
        },
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "9ssCCNM7"
        }
      ]
    },
    "erev-is-shabbos": {
      "rules": [],
      "inheritsRegular": false,
      "removedIds": []
    },
    "default": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -90,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [],
            "nextDay": false
          },
          "id": "JF_GZOkf"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "5eq-yJhc"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "z63GewZK"
        },
        {
          "id": "rmsw9j78o6",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": [],
            "nextDay": false
          }
        },
        {
          "label": "Den dim",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "55pifniQ"
        },
        {
          "id": "rmsw9l59v7",
          "label": "Dim lights (for sleeping children) mid seder",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 2,
            "level": 40,
            "fadeSec": 0,
            "zones": [
              2,
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "22:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmsw9oqel8",
          "label": "flash chandelier 15 min before Afikoman (chatzos)",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 7,
            "times": 1,
            "zones": [
              7
            ]
          },
          "trigger": {
            "kind": "zman",
            "zman": "chatzotNight",
            "offsetMin": -15,
            "day": "erev",
            "clamp": {},
            "conditions": [],
            "nextDay": true
          }
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:45",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "J1xhy0o_"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "03:15",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "pZao6W8Z"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "nqJwiiyS"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "87pXF4U3"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "VjSertDq"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "xZ35Pxw9"
        },
        {
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "clamp": {},
            "conditions": []
          },
          "id": "NSRF9HJv"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "1eEk-3NU"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "YOFkiZn0"
        },
        {
          "id": "rmswada161",
          "label": "Dim lights (for sleeping children) mid seder",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 2,
            "level": 40,
            "fadeSec": 0,
            "zones": [
              2,
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "22:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmswadrgi2",
          "label": "flash chandelier 15 min before Afikoman (chatzos)",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 7,
            "times": 1,
            "zones": [
              7
            ]
          },
          "trigger": {
            "kind": "zman",
            "zman": "chatzotNight",
            "offsetMin": -15,
            "clamp": {},
            "conditions": [],
            "nextDay": true
          }
        },
        {
          "id": "rmswae8ik3",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:45",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmswaeoh34",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "03:15",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    }
  },
  "sukkos-1": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [],
            "nextDay": false
          },
          "id": "RmDlG5IH"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "HmhsTyjA"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "nU-5Vngp"
        },
        {
          "label": "Den dim",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "Mt5BNGls"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "xwdGiz-L"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "3u7DrDR7"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "P7Jivm3Y"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "LW5RoleE"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "GkEYGPdT"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "umBZ88xm"
        },
        {
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "clamp": {},
            "conditions": []
          },
          "id": "vAF7UTAf"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "ASsnM6pI"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "R-vvY4kT"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "L0C0azda"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          },
          "id": "F-Z5t2rc"
        }
      ]
    },
    "guest": {
      "rules": [
        {
          "label": "Guest: Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "zones": [
              8
            ],
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "NHGpte9v"
        },
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "NlHa69K7"
        }
      ]
    }
  },
  "pesach-8": {
    "default": {
      "rules": [
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "dA518SG3"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "BCdwE8oJ"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "RoGXc0c2"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "7OAIsMG3"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          },
          "id": "cMieFsnQ"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "sxwz_BSw"
        }
      ]
    },
    "guest": {
      "rules": [
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "yZ0LMNSN"
        }
      ]
    }
  },
  "yom-kippur": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before Shabbos starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:00",
                  "day": "erev"
                },
                "then": {
                  "kind": "fixed",
                  "time": "18:00",
                  "day": "erev"
                }
              }
            ]
          },
          "id": "wp9gI0WV"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "srpOh0g3"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "mtHy2NV6"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "fixed",
            "time": "20:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "JOpIqMNz"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "1qMm8Iw2"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "IyDKmgw0"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "RYVrUJiJ"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          },
          "id": "PHr17tdE"
        },
        {
          "label": "End of Shabbos",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": []
          },
          "id": "OYLbpRgz"
        }
      ]
    },
    "guest": {
      "rules": [
        {
          "id": "rmsw8exsc0",
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          }
        }
      ]
    }
  },
  "rosh-hashanah-1": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [],
            "nextDay": false
          },
          "id": "pEaIk2pq"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "0sMJKqN2"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "2U_W8x62"
        },
        {
          "label": "Den dim",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "p0ntqGAi"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "3VbchTLv"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "LE5sJnim"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "izcOuaZ9"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "zecp0r-G"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "8HXNRLRb"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "-c6eBe3Y"
        },
        {
          "id": "rmsqk2l8m0",
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmssi4wff0",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          }
        },
        {
          "id": "rmssjykod1",
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmst7fcoa0",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmsvghttj0",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    },
    "on-shabbos": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:00",
                  "day": "erev"
                },
                "then": {
                  "kind": "fixed",
                  "time": "18:00",
                  "day": "erev"
                }
              }
            ],
            "nextDay": false
          },
          "id": "rmsvkdn1e5",
          "overridesId": "pEaIk2pq"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "rmsvkgy6g7",
          "overridesId": "3VbchTLv"
        }
      ],
      "inheritsRegular": true,
      "removedIds": []
    },
    "guest": {
      "rules": [
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 7,
            "level": 100,
            "fadeSec": 0,
            "zones": [
              7
            ]
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "-RluZO1V"
        },
        {
          "label": "Guest: Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "zones": [
              8
            ],
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "43qAqm5O"
        },
        {
          "id": "rmsw5ofmm0",
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    }
  },
  "rosh-hashanah-2": {
    "default": {
      "rules": [
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "sS6dSyKb"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "F1mwpF4L"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "RxFYnZNZ"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "nYes2Gmh"
        },
        {
          "id": "rmsvjqg943",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          }
        },
        {
          "id": "rmsvjr63b4",
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          }
        }
      ]
    },
    "leads-into-shabbos": {
      "rules": [],
      "inheritsRegular": true,
      "removedIds": [
        "rmsvjr63b4",
        "rmsvjqg943"
      ]
    },
    "guest": {
      "rules": [
        {
          "id": "rmsw63hnd2",
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    }
  },
  "shavuos-1": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:00",
                  "day": "erev"
                },
                "then": {
                  "kind": "fixed",
                  "time": "18:00",
                  "day": "erev"
                }
              }
            ],
            "nextDay": false
          },
          "id": "1dkREs42"
        },
        {
          "label": "Den dim",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "Pp1Xd44e"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "PCB7f9LV"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "-lJUtUYg"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "9rCWCs8e"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "9Xa-SE7S"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "C6SfRyjz"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "J-dUtM-T"
        },
        {
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "clamp": {},
            "conditions": []
          },
          "id": "8Th-WJUw"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "H-w_dSXE"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "TaJsuVdC"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "KptuDHFc"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          },
          "id": "RjrDD0B2"
        }
      ]
    },
    "guest": {
      "rules": [
        {
          "id": "rmsw7jh9k3",
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          }
        },
        {
          "id": "rmsw7jz7v4",
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    },
    "erev-is-shabbos": {
      "rules": [],
      "inheritsRegular": true,
      "removedIds": []
    },
    "leads-into-shabbos": {
      "rules": [
        {
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "rmswdf74g0",
          "overridesId": "8Th-WJUw"
        }
      ],
      "inheritsRegular": true,
      "removedIds": [
        "H-w_dSXE"
      ]
    }
  },
  "shavuos-2": {
    "default": {
      "rules": [
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "000bxUkX"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "KOwui_Ve"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "OCOZA9Kq"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "7Nidk_Jo"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          },
          "id": "9QtDDWKH"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "u5ZCNAGj"
        }
      ]
    },
    "guest": {
      "rules": [
        {
          "id": "rmsw7kxkd5",
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          }
        }
      ]
    }
  },
  "sukkos-2": {
    "default": {
      "rules": [
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "sp5DDgp6"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "5_Q-n88L"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "bRkE5jBW"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "qxTmUrHR"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          },
          "id": "dq6nF0aM"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "B51SKids"
        }
      ]
    },
    "guest": {
      "rules": []
    },
    "leads-into-shabbos": {
      "rules": [],
      "inheritsRegular": true,
      "removedIds": [
        "B51SKids",
        "dq6nF0aM"
      ]
    }
  },
  "shmini-atzeres": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [],
            "nextDay": false
          },
          "id": "C24HxHTa"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "L5egetPA"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "after",
                  "time": "19:45",
                  "day": "erev"
                },
                "then": {
                  "skip": true,
                  "day": "erev"
                }
              }
            ]
          },
          "id": "z9Sfu9Y8"
        },
        {
          "label": "Den dim",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "WL09mILY"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "glb3EN0d"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "gPjTjzBD"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "mVoPF2Jc"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "FZPmLl96"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "AK8umjs2"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "_6uJuzQU"
        },
        {
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -60,
            "clamp": {},
            "conditions": []
          },
          "id": "vmZfnQ5R"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "6lct5U8L"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "sH_jO6rE"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "E3PyY3yt"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          },
          "id": "1Q-w5jE3"
        }
      ]
    },
    "on-shabbos": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [],
            "nextDay": false
          },
          "id": "rmsw97tqv3",
          "overridesId": "C24HxHTa"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "6o-F8q8q"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "rmsw97wrr4",
          "overridesId": "glb3EN0d"
        }
      ],
      "inheritsRegular": true,
      "removedIds": []
    },
    "guest": {
      "rules": [
        {
          "label": "Kids sleeping downstairs off",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "DWJ1K0-d"
        },
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "ZIHdCHAu"
        }
      ]
    }
  },
  "simchas-torah": {
    "default": {
      "rules": [
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "0fYQayiQ"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "x_GUYsXh"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "62SNtrEL"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "KUxki69l"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "i-r4zYqV"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -100,
            "clamp": {},
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "kind": "zman",
                  "zman": "sunset",
                  "offsetMin": -40
                }
              }
            ]
          },
          "id": "_CBDHOrm"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "PkhHgqv-"
          },
          "trigger": {
            "kind": "zman",
            "zman": "havdalah",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "mBo9Q0ky"
        }
      ]
    },
    "leads-into-shabbos": {
      "rules": [],
      "inheritsRegular": true,
      "removedIds": [
        "mBo9Q0ky",
        "_CBDHOrm",
        "KUxki69l"
      ]
    },
    "guest": {
      "rules": [
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "GSCbXpjI"
        }
      ]
    }
  },
  "pesach-7": {
    "default": {
      "rules": [
        {
          "label": "Turn on lights before YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "candleLighting",
            "offsetMin": -60,
            "day": "erev",
            "clamp": {
              "notBefore": null
            },
            "conditions": [],
            "nextDay": false
          },
          "id": "QyWR0Nkv"
        },
        {
          "label": "5 min before Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 2
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -5,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "umugZgpu"
        },
        {
          "label": "Shkia reminder",
          "enabled": true,
          "action": {
            "type": "flash",
            "zone": 9,
            "seconds": 4
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": 0,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "rh6ZTN_R"
        },
        {
          "label": "Den dim",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "1stERKe9"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "wHFRcMdo"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "xzMFg9v7"
        },
        {
          "label": "Shabbos Morning",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "RM_Oig3S"
          },
          "trigger": {
            "kind": "fixed",
            "time": "09:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "LAbrXb_y"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "12:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "pvz9VK6F"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "jxI28eiw"
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "Ya9MCvsE"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 4,
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "16:00",
            "nextDay": false,
            "clamp": {
              "notBefore": null,
              "notAfter": null
            },
            "conditions": [
              {
                "if": {
                  "zman": "sunset",
                  "cmp": "before",
                  "time": "18:30"
                },
                "then": {
                  "skip": true
                }
              }
            ]
          },
          "id": "LtXPa8ay"
        },
        {
          "label": "Turn on lights before next day of YT starts",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "zman",
            "zman": "sunset",
            "offsetMin": -90,
            "clamp": {},
            "conditions": []
          },
          "id": "0D9eRw6F"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "lp6Yt4Hd"
          },
          "trigger": {
            "kind": "zman",
            "zman": "tzeit",
            "offsetMin": 0,
            "clamp": {},
            "conditions": [],
            "nextDay": false
          },
          "id": "JwAP61V1"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 5,
            "level": 60,
            "fadeSec": 0,
            "zones": [
              5
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "21:00",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "BcKkYlt_"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneEnd",
            "sceneId": "BtaJ8wJo"
          },
          "trigger": {
            "kind": "fixed",
            "time": "23:45",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "Z7K_LJnW"
        },
        {
          "label": "",
          "enabled": true,
          "action": {
            "type": "sceneStart",
            "sceneId": "X3wOusUc"
          },
          "trigger": {
            "kind": "fixed",
            "time": "02:30",
            "nextDay": true,
            "clamp": {},
            "conditions": []
          },
          "id": "vmXfqifR"
        }
      ]
    },
    "leads-into-shabbos": {
      "rules": [],
      "inheritsRegular": true,
      "removedIds": [
        "JwAP61V1"
      ]
    },
    "guest": {
      "rules": [
        {
          "label": "Guest: Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "zones": [
              8
            ],
            "level": 0,
            "fadeSec": 0
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "day": "erev",
            "clamp": {},
            "conditions": []
          },
          "id": "OEcs1ach"
        },
        {
          "label": "Basement off for sleeping children",
          "enabled": true,
          "action": {
            "type": "setLevel",
            "zone": 8,
            "level": 0,
            "fadeSec": 0,
            "zones": [
              8
            ]
          },
          "trigger": {
            "kind": "fixed",
            "time": "19:30",
            "nextDay": false,
            "clamp": {},
            "conditions": []
          },
          "id": "eDcxlv9P"
        }
      ]
    }
  }
};
