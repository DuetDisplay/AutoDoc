import type { UiLanguageCode } from '../../ui-language'
import type { en } from './en'

export const askAiOverlays: Record<
  Exclude<UiLanguageCode, 'en'>,
  Partial<Record<keyof typeof en, string>>
> = {
  de: {
    'askAi.scope': 'Besprechungsauswahl',
    'askAi.onlyMeeting': 'Nur diese Besprechung: {title}',
    'askAi.removeScope': 'Besprechungsauswahl entfernen',
    'askAi.countReceipt': 'Gezählt: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Alle Besprechungen durchsuchen',
    'askAi.askMeeting': 'Zu dieser Besprechung fragen'
  },
  ja: {
    'askAi.scope': '対象の会議',
    'askAi.onlyMeeting': 'この会議のみ：{title}',
    'askAi.removeScope': '会議の指定を解除',
    'askAi.countReceipt': '件数：{count}。条件：{filter}。',
    'askAi.searchAll': 'すべての会議を検索',
    'askAi.askMeeting': 'この会議について質問'
  },
  'zh-Hans': {
    'askAi.scope': '会议范围',
    'askAi.onlyMeeting': '仅此会议：{title}',
    'askAi.removeScope': '移除会议范围',
    'askAi.countReceipt': '已统计 {count} 项：{filter}。',
    'askAi.searchAll': '搜索所有会议',
    'askAi.askMeeting': '询问此会议'
  },
  ko: {
    'askAi.scope': '회의 범위',
    'askAi.onlyMeeting': '이 회의만: {title}',
    'askAi.removeScope': '회의 범위 해제',
    'askAi.countReceipt': '집계: {count}. 조건: {filter}.',
    'askAi.searchAll': '모든 회의 검색',
    'askAi.askMeeting': '이 회의에 대해 질문'
  },
  fr: {
    'askAi.scope': 'Périmètre de réunion',
    'askAi.onlyMeeting': 'Cette réunion uniquement : {title}',
    'askAi.removeScope': 'Retirer le périmètre de réunion',
    'askAi.countReceipt': 'Nombre : {count}. Filtre : {filter}.',
    'askAi.searchAll': 'Rechercher dans toutes les réunions',
    'askAi.askMeeting': 'Poser une question sur cette réunion'
  },
  es: {
    'askAi.scope': 'Ámbito de reunión',
    'askAi.onlyMeeting': 'Solo esta reunión: {title}',
    'askAi.removeScope': 'Quitar el ámbito de reunión',
    'askAi.countReceipt': 'Recuento: {count}. Filtro: {filter}.',
    'askAi.searchAll': 'Buscar en todas las reuniones',
    'askAi.askMeeting': 'Preguntar sobre esta reunión'
  },
  it: {
    'askAi.scope': 'Ambito della riunione',
    'askAi.onlyMeeting': 'Solo questa riunione: {title}',
    'askAi.removeScope': 'Rimuovi l’ambito della riunione',
    'askAi.countReceipt': 'Conteggio: {count}. Filtro: {filter}.',
    'askAi.searchAll': 'Cerca in tutte le riunioni',
    'askAi.askMeeting': 'Chiedi informazioni su questa riunione'
  },
  pt: {
    'askAi.scope': 'Âmbito da reunião',
    'askAi.onlyMeeting': 'Apenas esta reunião: {title}',
    'askAi.removeScope': 'Remover o âmbito da reunião',
    'askAi.countReceipt': 'Contagem: {count}. Filtro: {filter}.',
    'askAi.searchAll': 'Pesquisar em todas as reuniões',
    'askAi.askMeeting': 'Perguntar sobre esta reunião'
  },
  ru: {
    'askAi.scope': 'Область поиска по встречам',
    'askAi.onlyMeeting': 'Только эта встреча: {title}',
    'askAi.removeScope': 'Снять ограничение по встрече',
    'askAi.countReceipt': 'Количество: {count}. Фильтр: {filter}.',
    'askAi.searchAll': 'Искать по всем встречам',
    'askAi.askMeeting': 'Спросить об этой встрече'
  },
  uk: {
    'askAi.scope': 'Область пошуку зустрічей',
    'askAi.onlyMeeting': 'Лише ця зустріч: {title}',
    'askAi.removeScope': 'Зняти обмеження за зустріччю',
    'askAi.countReceipt': 'Кількість: {count}. Фільтр: {filter}.',
    'askAi.searchAll': 'Шукати в усіх зустрічах',
    'askAi.askMeeting': 'Запитати про цю зустріч'
  },
  bg: {
    'askAi.scope': 'Обхват на срещата',
    'askAi.onlyMeeting': 'Само тази среща: {title}',
    'askAi.removeScope': 'Премахване на обхвата на срещата',
    'askAi.countReceipt': 'Брой: {count}. Филтър: {filter}.',
    'askAi.searchAll': 'Търсене във всички срещи',
    'askAi.askMeeting': 'Въпрос за тази среща'
  },
  hr: {
    'askAi.scope': 'Opseg sastanka',
    'askAi.onlyMeeting': 'Samo ovaj sastanak: {title}',
    'askAi.removeScope': 'Ukloni opseg sastanka',
    'askAi.countReceipt': 'Broj: {count}. Filtar: {filter}.',
    'askAi.searchAll': 'Pretraži sve sastanke',
    'askAi.askMeeting': 'Pitaj o ovom sastanku'
  },
  cs: {
    'askAi.scope': 'Rozsah schůzky',
    'askAi.onlyMeeting': 'Pouze tato schůzka: {title}',
    'askAi.removeScope': 'Zrušit omezení na schůzku',
    'askAi.countReceipt': 'Počet: {count}. Filtr: {filter}.',
    'askAi.searchAll': 'Hledat ve všech schůzkách',
    'askAi.askMeeting': 'Zeptat se na tuto schůzku'
  },
  da: {
    'askAi.scope': 'Mødeafgrænsning',
    'askAi.onlyMeeting': 'Kun dette møde: {title}',
    'askAi.removeScope': 'Fjern mødeafgrænsning',
    'askAi.countReceipt': 'Antal: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Søg i alle møder',
    'askAi.askMeeting': 'Spørg om dette møde'
  },
  nl: {
    'askAi.scope': 'Vergaderbereik',
    'askAi.onlyMeeting': 'Alleen deze vergadering: {title}',
    'askAi.removeScope': 'Vergaderbereik verwijderen',
    'askAi.countReceipt': 'Geteld: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Alle vergaderingen doorzoeken',
    'askAi.askMeeting': 'Vragen over deze vergadering'
  },
  et: {
    'askAi.scope': 'Koosoleku ulatus',
    'askAi.onlyMeeting': 'Ainult see koosolek: {title}',
    'askAi.removeScope': 'Eemalda koosoleku piirang',
    'askAi.countReceipt': 'Arv: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Otsi kõigist koosolekutest',
    'askAi.askMeeting': 'Küsi selle koosoleku kohta'
  },
  fi: {
    'askAi.scope': 'Kokouksen rajaus',
    'askAi.onlyMeeting': 'Vain tämä kokous: {title}',
    'askAi.removeScope': 'Poista kokousrajaus',
    'askAi.countReceipt': 'Määrä: {count}. Suodatin: {filter}.',
    'askAi.searchAll': 'Hae kaikista kokouksista',
    'askAi.askMeeting': 'Kysy tästä kokouksesta'
  },
  el: {
    'askAi.scope': 'Πεδίο σύσκεψης',
    'askAi.onlyMeeting': 'Μόνο αυτή η σύσκεψη: {title}',
    'askAi.removeScope': 'Κατάργηση περιορισμού σύσκεψης',
    'askAi.countReceipt': 'Πλήθος: {count}. Φίλτρο: {filter}.',
    'askAi.searchAll': 'Αναζήτηση σε όλες τις συσκέψεις',
    'askAi.askMeeting': 'Ερώτηση για αυτή τη σύσκεψη'
  },
  hu: {
    'askAi.scope': 'Értekezlet hatóköre',
    'askAi.onlyMeeting': 'Csak ez az értekezlet: {title}',
    'askAi.removeScope': 'Értekezletszűrés eltávolítása',
    'askAi.countReceipt': 'Darabszám: {count}. Szűrő: {filter}.',
    'askAi.searchAll': 'Keresés minden értekezletben',
    'askAi.askMeeting': 'Kérdés erről az értekezletről'
  },
  lv: {
    'askAi.scope': 'Sanāksmes tvērums',
    'askAi.onlyMeeting': 'Tikai šī sanāksme: {title}',
    'askAi.removeScope': 'Noņemt sanāksmes ierobežojumu',
    'askAi.countReceipt': 'Skaits: {count}. Filtrs: {filter}.',
    'askAi.searchAll': 'Meklēt visās sanāksmēs',
    'askAi.askMeeting': 'Jautāt par šo sanāksmi'
  },
  lt: {
    'askAi.scope': 'Susitikimo aprėptis',
    'askAi.onlyMeeting': 'Tik šis susitikimas: {title}',
    'askAi.removeScope': 'Pašalinti susitikimo apribojimą',
    'askAi.countReceipt': 'Skaičius: {count}. Filtras: {filter}.',
    'askAi.searchAll': 'Ieškoti visuose susitikimuose',
    'askAi.askMeeting': 'Klausti apie šį susitikimą'
  },
  pl: {
    'askAi.scope': 'Zakres spotkania',
    'askAi.onlyMeeting': 'Tylko to spotkanie: {title}',
    'askAi.removeScope': 'Usuń ograniczenie do spotkania',
    'askAi.countReceipt': 'Liczba: {count}. Filtr: {filter}.',
    'askAi.searchAll': 'Szukaj we wszystkich spotkaniach',
    'askAi.askMeeting': 'Zapytaj o to spotkanie'
  },
  ro: {
    'askAi.scope': 'Domeniul întâlnirii',
    'askAi.onlyMeeting': 'Doar această întâlnire: {title}',
    'askAi.removeScope': 'Elimină restricția la întâlnire',
    'askAi.countReceipt': 'Număr: {count}. Filtru: {filter}.',
    'askAi.searchAll': 'Caută în toate întâlnirile',
    'askAi.askMeeting': 'Întreabă despre această întâlnire'
  },
  sk: {
    'askAi.scope': 'Rozsah schôdze',
    'askAi.onlyMeeting': 'Iba táto schôdza: {title}',
    'askAi.removeScope': 'Zrušiť obmedzenie na schôdzu',
    'askAi.countReceipt': 'Počet: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Hľadať vo všetkých schôdzach',
    'askAi.askMeeting': 'Opýtať sa na túto schôdzu'
  },
  sl: {
    'askAi.scope': 'Obseg sestanka',
    'askAi.onlyMeeting': 'Samo ta sestanek: {title}',
    'askAi.removeScope': 'Odstrani omejitev na sestanek',
    'askAi.countReceipt': 'Število: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Išči po vseh sestankih',
    'askAi.askMeeting': 'Vprašaj o tem sestanku'
  },
  sv: {
    'askAi.scope': 'Mötesavgränsning',
    'askAi.onlyMeeting': 'Endast detta möte: {title}',
    'askAi.removeScope': 'Ta bort mötesavgränsning',
    'askAi.countReceipt': 'Antal: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Sök i alla möten',
    'askAi.askMeeting': 'Fråga om det här mötet'
  }
}
