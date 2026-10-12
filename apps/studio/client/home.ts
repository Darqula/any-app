/**
 * The studio home page: entry point. Each module owns one part of the page and registers its own listeners;
 * they talk through the functions they export, not through shared variables.
 *
 *   sidebar   the app list              chat      the conversation panel
 *   poller    keeps both current        stage     opening and creating apps
 *   composer  the two prompt boxes      edit      applying an edit to the live preview
 *   delete    confirm and remove        preview   finding the iframe, its planning overlay
 */
import { initChat } from "./home/chat";
import { initComposer } from "./home/composer";
import { initDelete } from "./home/delete";
import { initEdit } from "./home/edit";
import { startPolling } from "./home/poller";
import { initPreview } from "./home/preview";
import { initStage } from "./home/stage";

initPreview();
initChat();
initStage();
initComposer();
initEdit();
initDelete();
startPolling();
