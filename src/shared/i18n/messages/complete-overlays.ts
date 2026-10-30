import type { UiLanguageCode } from '../../ui-language'
import type { completeEn } from './complete-en'
import de from './complete/de.json'
import ja from './complete/ja.json'
import fr from './complete/fr.json'
import ru from './complete/ru.json'
import es from './complete/es.json'
import ko from './complete/ko.json'
import bg from './complete/bg.json'
import hr from './complete/hr.json'
import cs from './complete/cs.json'
import da from './complete/da.json'
import nl from './complete/nl.json'
import et from './complete/et.json'
import fi from './complete/fi.json'
import el from './complete/el.json'
import hu from './complete/hu.json'
import it from './complete/it.json'
import lv from './complete/lv.json'
import lt from './complete/lt.json'
import pl from './complete/pl.json'
import pt from './complete/pt.json'
import ro from './complete/ro.json'
import sk from './complete/sk.json'
import sl from './complete/sl.json'
import sv from './complete/sv.json'
import uk from './complete/uk.json'
import zh_Hans from './complete/zh-Hans.json'

export const completeOverlays = {
  de: de,
  ja: ja,
  fr: fr,
  ru: ru,
  es: es,
  ko: ko,
  bg: bg,
  hr: hr,
  cs: cs,
  da: da,
  nl: nl,
  et: et,
  fi: fi,
  el: el,
  hu: hu,
  it: it,
  lv: lv,
  lt: lt,
  pl: pl,
  pt: pt,
  ro: ro,
  sk: sk,
  sl: sl,
  sv: sv,
  uk: uk,
  'zh-Hans': zh_Hans
} satisfies Record<Exclude<UiLanguageCode, 'en'>, Record<keyof typeof completeEn, string>>
