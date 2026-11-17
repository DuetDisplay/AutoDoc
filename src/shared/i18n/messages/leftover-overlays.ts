import type { UiLanguageCode } from '../../ui-language'
import type { MessageCatalog } from './en'

type LeftoverOverlay = Partial<MessageCatalog>

export const leftoverOverlays: Partial<Record<UiLanguageCode, LeftoverOverlay>> = {
  ko: {
    'meeting.reprocessTranscriptHint': '오디오를 다시 받아쓰고 새 텍스트에서 노트를 재생성합니다',
    'meeting.reprocessNotesHint': '기존 텍스트에서 AI 노트를 재생성합니다',
    'meeting.reprocess': '재처리',
    'meeting.queued': '대기 중...',
    'meeting.dangerZone': '위험 영역',
    'meeting.cannotUndo': '이 작업은 취소할 수 없습니다.',
    'meeting.deleteRecording': '녹음 삭제',
    'meeting.deleteRecordingHint': '모든 오디오, 동영상, 대화 기록, 노트를 영구적으로 제거합니다',
    'meeting.confirmDelete': '삭제 확인',
    'meeting.deleteBlocked': '삭제하려면 먼저 녹음을 중지하고 저장과 텍스트 변환이 끝날 때까지 기다리세요.',
    'meeting.deleteFailed': '이 녹음을 삭제할 수 없습니다. 다시 시도하세요.',
    'recording.saveFailedStopped':
      'AutoDoc에서 저장할 수 없어 녹음이 중지되었습니다. 일부 내용이 누락되었을 수 있습니다. 다시 녹음하기 전에 디스크 여유 공간을 확인하세요.'
  },
  ja: {
    'meeting.reprocessTranscriptHint': 'オーディオを文字起こしし直し、新しい文字起こしからノートを再生成します',
    'meeting.reprocessNotesHint': '既存の文字起こしからAIノートを再生成します',
    'meeting.reprocess': '再処理',
    'meeting.queued': '待機中...',
    'meeting.dangerZone': '危険ゾーン',
    'meeting.cannotUndo': 'この操作は元に戻せません。',
    'meeting.deleteRecording': '録音を削除',
    'meeting.deleteRecordingHint': 'すべてのオーディオ、動画、文字起こし、ノートを完全に削除します',
    'meeting.confirmDelete': '削除を確認',
    'meeting.deleteBlocked': '削除するには、録音を停止し、保存と文字起こしが完了するまでお待ちください。',
    'meeting.deleteFailed': 'この録音を削除できませんでした。もう一度お試しください。',
    'recording.saveFailedStopped':
      'AutoDocが保存できなかったため、録音を停止しました。一部が欠けている可能性があります。もう一度録音する前に、ディスクの空き容量を確認してください。'
  },
  'zh-Hans': {
    'meeting.reprocessTranscriptHint': '重新转录音频并从新转录稿生成笔记',
    'meeting.reprocessNotesHint': '从现有转录稿重新生成 AI 笔记',
    'meeting.reprocess': '重新处理',
    'meeting.queued': '排队中...',
    'meeting.dangerZone': '危险区域',
    'meeting.cannotUndo': '此操作无法撤销。',
    'meeting.deleteRecording': '删除录音',
    'meeting.deleteRecordingHint': '永久删除所有音频、视频、转录稿和笔记',
    'meeting.confirmDelete': '确认删除',
    'meeting.deleteBlocked': '请先停止录音，并等待保存和转录完成，然后再删除。',
    'meeting.deleteFailed': '无法删除此录音。请重试。',
    'recording.saveFailedStopped': 'AutoDoc 无法保存录音，因此已停止录音。部分内容可能缺失。再次录音前，请检查可用磁盘空间。'
  },
  de: {
    'meeting.reprocessTranscriptHint':
      'Audio neu transkribieren und Notizen aus dem neuen Transkript erstellen',
    'meeting.reprocessNotesHint': 'KI-Notizen aus dem bestehenden Transkript neu erstellen',
    'meeting.reprocess': 'Neu verarbeiten',
    'meeting.queued': 'In der Warteschlange...',
    'meeting.dangerZone': 'Gefahrenzone',
    'meeting.cannotUndo': 'Diese Aktion kann nicht rückgängig gemacht werden.',
    'meeting.deleteRecording': 'Aufnahme löschen',
    'meeting.deleteRecordingHint':
      'Alle Audio-, Video-, Transkript- und Notizdateien dauerhaft entfernen',
    'meeting.confirmDelete': 'Löschen bestätigen',
    'meeting.deleteBlocked':
      'Zum Löschen zuerst die Aufnahme beenden und warten, bis Speichern und Transkription abgeschlossen sind.',
    'meeting.deleteFailed': 'Diese Aufnahme konnte nicht gelöscht werden. Bitte erneut versuchen.',
    'recording.saveFailedStopped':
      'Die Aufnahme wurde beendet, weil AutoDoc sie nicht speichern konnte. Teile davon fehlen möglicherweise. Vor der nächsten Aufnahme den freien Speicherplatz prüfen.'
  },
  fr: {
    'meeting.reprocessTranscriptHint':
      'Retranscrire l\u2019audio et régénérer les notes depuis la nouvelle transcription',
    'meeting.reprocessNotesHint':
      'Régénérer les notes IA depuis la transcription existante',
    'meeting.reprocess': 'Retraiter',
    'meeting.queued': 'En attente...',
    'meeting.dangerZone': 'Zone dangereuse',
    'meeting.cannotUndo': 'Cette action est irréversible.',
    'meeting.deleteRecording': 'Supprimer l\u2019enregistrement',
    'meeting.deleteRecordingHint':
      'Supprimer définitivement tout l\u2019audio, la vidéo, la transcription et les notes',
    'meeting.confirmDelete': 'Confirmer la suppression',
    'meeting.deleteBlocked':
      "Arrêtez l'enregistrement et attendez la fin de la sauvegarde et de la transcription avant de le supprimer.",
    'meeting.deleteFailed': 'Impossible de supprimer cet enregistrement. Réessayez.',
    'recording.saveFailedStopped':
      "L'enregistrement a été interrompu, car AutoDoc n'a pas pu le sauvegarder. Il se peut qu'une partie manque. Vérifiez l'espace disque disponible avant d'enregistrer à nouveau."
  },
  es: {
    'meeting.reprocessTranscriptHint':
      'Volver a transcribir el audio y regenerar las notas a partir de la nueva transcripción',
    'meeting.reprocessNotesHint':
      'Regenerar las notas de IA a partir de la transcripción existente',
    'meeting.reprocess': 'Reprocesar',
    'meeting.queued': 'En cola...',
    'meeting.dangerZone': 'Zona peligrosa',
    'meeting.cannotUndo': 'Esta acción no se puede deshacer.',
    'meeting.deleteRecording': 'Eliminar grabación',
    'meeting.deleteRecordingHint':
      'Eliminar permanentemente todo el audio, vídeo, transcripción y notas',
    'meeting.confirmDelete': 'Confirmar eliminación',
    'meeting.deleteBlocked':
      'Detén la grabación y espera a que terminen el guardado y la transcripción antes de eliminarla.',
    'meeting.deleteFailed': 'No se pudo eliminar esta grabación. Inténtalo de nuevo.',
    'recording.saveFailedStopped':
      'La grabación se detuvo porque AutoDoc no pudo guardarla. Puede que falte una parte. Comprueba el espacio libre en disco antes de volver a grabar.'
  },
  it: {
    'meeting.reprocessTranscriptHint':
      'Ritrascrivere l\u2019audio e rigenerare le note dalla nuova trascrizione',
    'meeting.reprocessNotesHint': 'Rigenerare le note IA dalla trascrizione esistente',
    'meeting.reprocess': 'Rielabora',
    'meeting.queued': 'In coda...',
    'meeting.dangerZone': 'Zona pericolosa',
    'meeting.cannotUndo': 'Questa azione non può essere annullata.',
    'meeting.deleteRecording': 'Elimina registrazione',
    'meeting.deleteRecordingHint': 'Rimuovi definitivamente audio, video, trascrizione e note',
    'meeting.confirmDelete': 'Conferma eliminazione',
    'meeting.deleteBlocked':
      'Interrompi la registrazione e attendi il termine del salvataggio e della trascrizione prima di eliminarla.',
    'meeting.deleteFailed': 'Impossibile eliminare questa registrazione. Riprova.',
    'recording.saveFailedStopped':
      'La registrazione si è interrotta perché AutoDoc non è riuscito a salvarla. Una parte potrebbe mancare. Controlla lo spazio libero su disco prima di registrare di nuovo.'
  },
  pt: {
    'meeting.reprocessTranscriptHint':
      'Transcrever novamente o áudio e regenerar notas a partir da nova transcrição',
    'meeting.reprocessNotesHint': 'Regenerar notas de IA a partir da transcrição existente',
    'meeting.reprocess': 'Reprocessar',
    'meeting.queued': 'Na fila...',
    'meeting.dangerZone': 'Zona de perigo',
    'meeting.cannotUndo': 'Esta ação não pode ser desfeita.',
    'meeting.deleteRecording': 'Eliminar gravação',
    'meeting.deleteRecordingHint':
      'Remover permanentemente todo o áudio, vídeo, transcrição e notas',
    'meeting.confirmDelete': 'Confirmar eliminação',
    'meeting.deleteBlocked':
      'Pare a gravação e aguarde até estar guardada e transcrita antes de a eliminar.',
    'meeting.deleteFailed': 'Não foi possível eliminar esta gravação. Tente novamente.',
    'recording.saveFailedStopped':
      'A gravação foi interrompida porque o AutoDoc não conseguiu guardá-la. Parte dela pode estar em falta. Verifique o espaço livre em disco antes de gravar novamente.'
  },
  nl: {
    'meeting.reprocessTranscriptHint':
      'Audio opnieuw transcriberen en notities opnieuw genereren vanuit het nieuwe transcript',
    'meeting.reprocessNotesHint':
      'AI-notities opnieuw genereren vanuit het bestaande transcript',
    'meeting.reprocess': 'Opnieuw verwerken',
    'meeting.queued': 'In wachtrij...',
    'meeting.dangerZone': 'Gevarenzone',
    'meeting.cannotUndo': 'Deze actie kan niet ongedaan worden gemaakt.',
    'meeting.deleteRecording': 'Opname verwijderen',
    'meeting.deleteRecordingHint':
      'Alle audio, video, transcript en notities permanent verwijderen',
    'meeting.confirmDelete': 'Verwijdering bevestigen',
    'meeting.deleteBlocked':
      'Stop de opname en wacht tot opslaan en transcriberen klaar zijn voordat je hem verwijdert.',
    'meeting.deleteFailed': 'Kan deze opname niet verwijderen. Probeer het opnieuw.',
    'recording.saveFailedStopped':
      'De opname is gestopt omdat AutoDoc deze niet kon opslaan. Een deel kan ontbreken. Controleer de vrije schijfruimte voordat je opnieuw opneemt.'
  },
  sv: {
    'meeting.reprocessTranscriptHint':
      'Transkribera om ljudet och generera om anteckningar från den nya transkriptionen',
    'meeting.reprocessNotesHint':
      'Generera om AI-anteckningar från den befintliga transkriptionen',
    'meeting.reprocess': 'Bearbeta om',
    'meeting.queued': 'I kö...',
    'meeting.dangerZone': 'Farozon',
    'meeting.cannotUndo': 'Den här åtgärden kan inte ångras.',
    'meeting.deleteRecording': 'Radera inspelning',
    'meeting.deleteRecordingHint':
      'Ta bort allt ljud, video, transkription och anteckningar permanent',
    'meeting.confirmDelete': 'Bekräfta radering',
    'meeting.deleteBlocked':
      'Stoppa inspelningen och vänta tills sparning och transkribering är klara innan du raderar den.',
    'meeting.deleteFailed': 'Det gick inte att radera inspelningen. Försök igen.',
    'recording.saveFailedStopped':
      'Inspelningen stoppades eftersom AutoDoc inte kunde spara den. En del kan saknas. Kontrollera ledigt diskutrymme innan du spelar in igen.'
  },
  da: {
    'meeting.reprocessTranscriptHint':
      'Transskribér lyden igen og regenerér noter fra den nye transskription',
    'meeting.reprocessNotesHint': 'Regenerér AI-noter fra den eksisterende transskription',
    'meeting.reprocess': 'Genbehandl',
    'meeting.queued': 'I kø...',
    'meeting.dangerZone': 'Farezonen',
    'meeting.cannotUndo': 'Denne handling kan ikke fortrydes.',
    'meeting.deleteRecording': 'Slet optagelse',
    'meeting.deleteRecordingHint':
      'Fjern al lyd, video, transskription og noter permanent',
    'meeting.confirmDelete': 'Bekræft sletning',
    'meeting.deleteBlocked':
      'Stop optagelsen, og vent, til lagring og transskribering er færdige, før du sletter den.',
    'meeting.deleteFailed': 'Optagelsen kunne ikke slettes. Prøv igen.',
    'recording.saveFailedStopped':
      'Optagelsen stoppede, fordi AutoDoc ikke kunne gemme den. Noget af den kan mangle. Tjek den ledige diskplads, før du optager igen.'
  },
  fi: {
    'meeting.reprocessTranscriptHint':
      'Litteroi ääni uudelleen ja luo muistiinpanot uudesta litteroinnista',
    'meeting.reprocessNotesHint':
      'Luo AI-muistiinpanot uudelleen olemassa olevasta litteroinnista',
    'meeting.reprocess': 'Käsittele uudelleen',
    'meeting.queued': 'Jonossa...',
    'meeting.dangerZone': 'Vaaravyöhyke',
    'meeting.cannotUndo': 'Tätä toimintoa ei voi kumota.',
    'meeting.deleteRecording': 'Poista nauhoitus',
    'meeting.deleteRecordingHint':
      'Poista pysyvästi kaikki ääni, video, litterointi ja muistiinpanot',
    'meeting.confirmDelete': 'Vahvista poistaminen',
    'meeting.deleteBlocked':
      'Pysäytä nauhoitus ja odota, että tallennus ja litterointi ovat valmiit, ennen kuin poistat sen.',
    'meeting.deleteFailed': 'Nauhoitusta ei voitu poistaa. Yritä uudelleen.',
    'recording.saveFailedStopped':
      'Nauhoitus pysähtyi, koska AutoDoc ei voinut tallentaa sitä. Osa siitä voi puuttua. Tarkista vapaa levytila ennen uutta nauhoitusta.'
  },
  pl: {
    'meeting.reprocessTranscriptHint':
      'Ponownie transkrybuj dźwięk i generuj notatki na podstawie nowej transkrypcji',
    'meeting.reprocessNotesHint':
      'Wygeneruj ponownie notatki AI na podstawie istniejącej transkrypcji',
    'meeting.reprocess': 'Przetwórz ponownie',
    'meeting.queued': 'W kolejce...',
    'meeting.dangerZone': 'Strefa niebezpieczna',
    'meeting.cannotUndo': 'Tej akcji nie można cofnąć.',
    'meeting.deleteRecording': 'Usuń nagranie',
    'meeting.deleteRecordingHint':
      'Trwale usuń wszystkie pliki audio, wideo, transkrypcję i notatki',
    'meeting.confirmDelete': 'Potwierdź usunięcie',
    'meeting.deleteBlocked':
      'Zatrzymaj nagrywanie i poczekaj na zakończenie zapisywania i transkrypcji, zanim usuniesz nagranie.',
    'meeting.deleteFailed': 'Nie można usunąć tego nagrania. Spróbuj ponownie.',
    'recording.saveFailedStopped':
      'Nagrywanie zostało zatrzymane, ponieważ AutoDoc nie mógł go zapisać. Części nagrania może brakować. Sprawdź wolne miejsce na dysku przed kolejnym nagrywaniem.'
  },
  ru: {
    'meeting.reprocessTranscriptHint':
      'Повторно транскрибировать аудио и создать заметки из нового транскрипта',
    'meeting.reprocessNotesHint':
      'Повторно создать заметки ИИ из существующего транскрипта',
    'meeting.reprocess': 'Переработать',
    'meeting.queued': 'В очереди...',
    'meeting.dangerZone': 'Опасная зона',
    'meeting.cannotUndo': 'Это действие невозможно отменить.',
    'meeting.deleteRecording': 'Удалить запись',
    'meeting.deleteRecordingHint':
      'Безвозвратно удалить всё аудио, видео, транскрипт и заметки',
    'meeting.confirmDelete': 'Подтвердить удаление',
    'meeting.deleteBlocked':
      'Остановите запись и дождитесь завершения сохранения и расшифровки, прежде чем удалять её.',
    'meeting.deleteFailed': 'Не удалось удалить эту запись. Повторите попытку.',
    'recording.saveFailedStopped':
      'Запись остановлена, так как AutoDoc не смог её сохранить. Часть записи может отсутствовать. Перед новой записью проверьте свободное место на диске.'
  },
  uk: {
    'meeting.reprocessTranscriptHint':
      'Перетранскрибувати аудіо і відновити нотатки з нового транскрипту',
    'meeting.reprocessNotesHint': 'Відновити нотатки ШІ з існуючого транскрипту',
    'meeting.reprocess': 'Переопрацювати',
    'meeting.queued': 'У черзі...',
    'meeting.dangerZone': 'Небезпечна зона',
    'meeting.cannotUndo': 'Цю дію не можна скасувати.',
    'meeting.deleteRecording': 'Видалити запис',
    'meeting.deleteRecordingHint':
      'Назавжди видалити всі аудіо, відео, транскрипт і нотатки',
    'meeting.confirmDelete': 'Підтвердити видалення',
    'meeting.deleteBlocked':
      'Зупиніть запис і дочекайтеся завершення збереження та транскрибування, перш ніж видаляти його.',
    'meeting.deleteFailed': 'Не вдалося видалити цей запис. Спробуйте ще раз.',
    'recording.saveFailedStopped':
      'Запис зупинено, оскільки AutoDoc не зміг його зберегти. Частина запису може бути відсутня. Перед новим записом перевірте вільне місце на диску.'
  },
  cs: {
    'meeting.reprocessTranscriptHint':
      'Přepsat znovu audio a regenerovat poznámky z nového přepisu',
    'meeting.reprocessNotesHint': 'Regenerovat poznámky AI ze stávajícího přepisu',
    'meeting.reprocess': 'Znovu zpracovat',
    'meeting.queued': 'Ve frontě...',
    'meeting.dangerZone': 'Nebezpečná zóna',
    'meeting.cannotUndo': 'Tuto akci nelze vrátit.',
    'meeting.deleteRecording': 'Smazat nahrávku',
    'meeting.deleteRecordingHint':
      'Trvale odstranit veškeré audio, video, přepis a poznámky',
    'meeting.confirmDelete': 'Potvrdit smazání',
    'meeting.deleteBlocked':
      'Před odstraněním nahrávání zastavte a počkejte na dokončení ukládání a přepisu.',
    'meeting.deleteFailed': 'Tuto nahrávku se nepodařilo odstranit. Zkuste to znovu.',
    'recording.saveFailedStopped':
      'Nahrávání se zastavilo, protože AutoDoc nemohl nahrávku uložit. Část může chybět. Před dalším nahráváním zkontrolujte volné místo na disku.'
  },
  sk: {
    'meeting.reprocessTranscriptHint':
      'Znovu prepísať zvuk a regenerovať poznámky z nového prepisu',
    'meeting.reprocessNotesHint': 'Regenerovať poznámky AI z existujúceho prepisu',
    'meeting.reprocess': 'Znovu spracovať',
    'meeting.queued': 'V poradí...',
    'meeting.dangerZone': 'Nebezpečná zóna',
    'meeting.cannotUndo': 'Túto akciu nie je možné vrátiť späť.',
    'meeting.deleteRecording': 'Vymazať nahrávku',
    'meeting.deleteRecordingHint':
      'Trvalo odstrániť všetky zvuky, video, prepis a poznámky',
    'meeting.confirmDelete': 'Potvrdiť vymazanie',
    'meeting.deleteBlocked':
      'Pred odstránením nahrávanie zastavte a počkajte na dokončenie ukladania a prepisu.',
    'meeting.deleteFailed': 'Túto nahrávku sa nepodarilo odstrániť. Skúste to znova.',
    'recording.saveFailedStopped':
      'Nahrávanie sa zastavilo, pretože AutoDoc nemohol nahrávku uložiť. Časť môže chýbať. Pred ďalším nahrávaním skontrolujte voľné miesto na disku.'
  },
  sl: {
    'meeting.reprocessTranscriptHint':
      'Znova prepiši zvok in ustvari zapiske iz novega prepisa',
    'meeting.reprocessNotesHint': 'Znova ustvari zapiske AI iz obstoječega prepisa',
    'meeting.reprocess': 'Znova obdelaj',
    'meeting.queued': 'V čakalni vrsti...',
    'meeting.dangerZone': 'Nevarno območje',
    'meeting.cannotUndo': 'Tega dejanja ni mogoče razveljaviti.',
    'meeting.deleteRecording': 'Izbriši posnetek',
    'meeting.deleteRecordingHint':
      'Trajno odstrani ves zvok, video, prepis in zapiske',
    'meeting.confirmDelete': 'Potrdi brisanje',
    'meeting.deleteBlocked':
      'Pred brisanjem ustavite snemanje in počakajte, da se shranjevanje in prepis končata.',
    'meeting.deleteFailed': 'Tega posnetka ni bilo mogoče izbrisati. Poskusite znova.',
    'recording.saveFailedStopped':
      'Snemanje se je ustavilo, ker AutoDoc posnetka ni mogel shraniti. Del posnetka morda manjka. Pred naslednjim snemanjem preverite prosti prostor na disku.'
  },
  hr: {
    'meeting.reprocessTranscriptHint':
      'Ponovo transkribiraj zvuk i regeneriraj bilješke iz novog transkripta',
    'meeting.reprocessNotesHint': 'Regeneriraj AI bilješke iz postojećeg transkripta',
    'meeting.reprocess': 'Obradi ponovo',
    'meeting.queued': 'U redu čekanja...',
    'meeting.dangerZone': 'Opasna zona',
    'meeting.cannotUndo': 'Ova radnja se ne može poništiti.',
    'meeting.deleteRecording': 'Obriši snimku',
    'meeting.deleteRecordingHint':
      'Trajno ukloni sve audio, video, transkript i bilješke',
    'meeting.confirmDelete': 'Potvrdi brisanje',
    'meeting.deleteBlocked':
      'Prije brisanja zaustavite snimanje i pričekajte da se spremanje i transkripcija završe.',
    'meeting.deleteFailed': 'Ovu snimku nije moguće izbrisati. Pokušajte ponovno.',
    'recording.saveFailedStopped':
      'Snimanje je zaustavljeno jer AutoDoc nije mogao spremiti snimku. Dio snimke možda nedostaje. Prije novog snimanja provjerite slobodan prostor na disku.'
  },
  bg: {
    'meeting.reprocessTranscriptHint':
      'Транскрибирай отново аудиото и регенерирай бележките от новия транскрипт',
    'meeting.reprocessNotesHint':
      'Регенерирай бележките с ИИ от съществуващия транскрипт',
    'meeting.reprocess': 'Преработи',
    'meeting.queued': 'В опашка...',
    'meeting.dangerZone': 'Опасна зона',
    'meeting.cannotUndo': 'Това действие не може да се отмени.',
    'meeting.deleteRecording': 'Изтрий записа',
    'meeting.deleteRecordingHint':
      'Премахни за постоянно всички аудио, видео, транскрипт и бележки',
    'meeting.confirmDelete': 'Потвърди изтриването',
    'meeting.deleteBlocked':
      'Спрете записа и изчакайте запазването и транскрипцията да приключат, преди да го изтриете.',
    'meeting.deleteFailed': 'Този запис не можа да бъде изтрит. Опитайте отново.',
    'recording.saveFailedStopped':
      'Записът спря, защото AutoDoc не успя да го запази. Част от него може да липсва. Преди нов запис проверете свободното място на диска.'
  },
  ro: {
    'meeting.reprocessTranscriptHint':
      'Retranscrie audio-ul și regenerează notele din noua transcriere',
    'meeting.reprocessNotesHint': 'Regenerează notele AI din transcrierea existentă',
    'meeting.reprocess': 'Reprocesează',
    'meeting.queued': 'În coadă...',
    'meeting.dangerZone': 'Zonă periculoasă',
    'meeting.cannotUndo': 'Această acțiune nu poate fi anulată.',
    'meeting.deleteRecording': 'Șterge înregistrarea',
    'meeting.deleteRecordingHint':
      'Elimină permanent tot audio-ul, video-ul, transcrierea și notele',
    'meeting.confirmDelete': 'Confirmă ștergerea',
    'meeting.deleteBlocked':
      'Opriți înregistrarea și așteptați finalizarea salvării și a transcrierii înainte de a o șterge.',
    'meeting.deleteFailed': 'Această înregistrare nu a putut fi ștearsă. Încercați din nou.',
    'recording.saveFailedStopped':
      'Înregistrarea s-a oprit deoarece AutoDoc nu a putut-o salva. O parte poate lipsi. Verificați spațiul liber pe disc înainte de a înregistra din nou.'
  },
  hu: {
    'meeting.reprocessTranscriptHint':
      'Hanganyag újraátirata és jegyzetek regenerálása az új átiratból',
    'meeting.reprocessNotesHint': 'AI-jegyzetek regenerálása a meglévő átiratból',
    'meeting.reprocess': 'Újrafeldolgozás',
    'meeting.queued': 'Várakozik...',
    'meeting.dangerZone': 'Veszélyes zóna',
    'meeting.cannotUndo': 'Ez a művelet nem vonható vissza.',
    'meeting.deleteRecording': 'Felvétel törlése',
    'meeting.deleteRecordingHint':
      'Az összes hang, videó, átirat és jegyzet végleges eltávolítása',
    'meeting.confirmDelete': 'Törlés megerősítése',
    'meeting.deleteBlocked':
      'A törlés előtt állítsa le a felvételt, és várja meg a mentés és az átírás befejezését.',
    'meeting.deleteFailed': 'Ezt a felvételt nem sikerült törölni. Próbálja újra.',
    'recording.saveFailedStopped':
      'A felvétel leállt, mert az AutoDoc nem tudta menteni. Egy része hiányozhat. Új felvétel előtt ellenőrizze a szabad lemezterületet.'
  },
  el: {
    'meeting.reprocessTranscriptHint':
      'Επαναμεταγραφή ήχου και αναγέννηση σημειώσεων από τη νέα μεταγραφή',
    'meeting.reprocessNotesHint':
      'Αναγέννηση σημειώσεων AI από την υπάρχουσα μεταγραφή',
    'meeting.reprocess': 'Επανεπεξεργασία',
    'meeting.queued': 'Σε αναμονή...',
    'meeting.dangerZone': 'Επικίνδυνη ζώνη',
    'meeting.cannotUndo': 'Αυτή η ενέργεια δεν μπορεί να αναιρεθεί.',
    'meeting.deleteRecording': 'Διαγραφή εγγραφής',
    'meeting.deleteRecordingHint':
      'Μόνιμη αφαίρεση όλου του ήχου, βίντεο, μεταγραφής και σημειώσεων',
    'meeting.confirmDelete': 'Επιβεβαίωση διαγραφής',
    'meeting.deleteBlocked':
      'Σταματήστε την εγγραφή και περιμένετε να ολοκληρωθούν η αποθήκευση και η απομαγνητοφώνηση πριν τη διαγράψετε.',
    'meeting.deleteFailed': 'Δεν ήταν δυνατή η διαγραφή αυτής της εγγραφής. Δοκιμάστε ξανά.',
    'recording.saveFailedStopped':
      'Η εγγραφή σταμάτησε επειδή το AutoDoc δεν μπόρεσε να την αποθηκεύσει. Ένα μέρος της ίσως λείπει. Ελέγξτε τον ελεύθερο χώρο στον δίσκο πριν κάνετε νέα εγγραφή.'
  },
  et: {
    'meeting.reprocessTranscriptHint':
      'Transkribeeri heli uuesti ja loo märkmed uuest transkriptsioonist',
    'meeting.reprocessNotesHint':
      'Loo AI märkmed uuesti olemasolevast transkriptsioonist',
    'meeting.reprocess': 'Töötle uuesti',
    'meeting.queued': 'Järjekorras...',
    'meeting.dangerZone': 'Ohtlik tsoon',
    'meeting.cannotUndo': 'Seda toimingut ei saa tagasi võtta.',
    'meeting.deleteRecording': 'Kustuta salvestis',
    'meeting.deleteRecordingHint':
      'Eemalda jäädavalt kogu heli, video, transkriptsioon ja märkmed',
    'meeting.confirmDelete': 'Kinnita kustutamine',
    'meeting.deleteBlocked':
      'Enne kustutamist peatage salvestamine ja oodake, kuni salvestise talletamine ja transkribeerimine on lõppenud.',
    'meeting.deleteFailed': 'Seda salvestist ei õnnestunud kustutada. Proovige uuesti.',
    'recording.saveFailedStopped':
      'Salvestamine peatus, sest AutoDoc ei saanud salvestist talletada. Osa sellest võib puududa. Enne uut salvestamist kontrollige vaba kettaruumi.'
  },
  lv: {
    'meeting.reprocessTranscriptHint':
      'Atkārtoti atšifrēt audio un atkārtoti ģenerēt piezīmes no jaunā atšifrējuma',
    'meeting.reprocessNotesHint':
      'Atkārtoti ģenerēt AI piezīmes no esošā atšifrējuma',
    'meeting.reprocess': 'Apstrādāt atkārtoti',
    'meeting.queued': 'Rindā...',
    'meeting.dangerZone': 'Bīstamā zona',
    'meeting.cannotUndo': 'Šo darbību nevar atsaukt.',
    'meeting.deleteRecording': 'Dzēst ierakstu',
    'meeting.deleteRecordingHint':
      'Neatgriezeniski noņemt visus audio, video, atšifrējumu un piezīmes',
    'meeting.confirmDelete': 'Apstiprināt dzēšanu',
    'meeting.deleteBlocked':
      'Pirms dzēšanas apturiet ierakstīšanu un pagaidiet, līdz saglabāšana un transkribēšana beidzas.',
    'meeting.deleteFailed': 'Šo ierakstu neizdevās izdzēst. Mēģiniet vēlreiz.',
    'recording.saveFailedStopped':
      'Ierakstīšana tika apturēta, jo AutoDoc nevarēja saglabāt ierakstu. Daļa var trūkt. Pirms nākamās ierakstīšanas pārbaudiet brīvo vietu diskā.'
  },
  lt: {
    'meeting.reprocessTranscriptHint':
      'Iš naujo transkribuoti garsą ir generuoti pastabas iš naujo transkripto',
    'meeting.reprocessNotesHint': 'Iš naujo generuoti DI pastabas iš esamo transkripto',
    'meeting.reprocess': 'Apdoroti iš naujo',
    'meeting.queued': 'Eilėje...',
    'meeting.dangerZone': 'Pavojinga zona',
    'meeting.cannotUndo': 'Šio veiksmo negalima atšaukti.',
    'meeting.deleteRecording': 'Ištrinti įrašą',
    'meeting.deleteRecordingHint':
      'Visam laikui pašalinti visą garsą, vaizdo įrašą, transkriptą ir pastabas',
    'meeting.confirmDelete': 'Patvirtinti ištrynimą',
    'meeting.deleteBlocked':
      'Prieš ištrindami sustabdykite įrašymą ir palaukite, kol baigsis išsaugojimas ir transkribavimas.',
    'meeting.deleteFailed': 'Šio įrašo ištrinti nepavyko. Bandykite dar kartą.',
    'recording.saveFailedStopped':
      'Įrašymas sustabdytas, nes „AutoDoc“ negalėjo išsaugoti įrašo. Dalies gali trūkti. Prieš vėl įrašydami patikrinkite laisvą vietą diske.'
  }
}
