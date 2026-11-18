// Browser bundle of the Nexconn SDKs, exposed as window.HCNex:
//  - chat:   @nexconn/chat   (NCEngine: connection, channels, messages)
//  - chatui: @nexconn/chatui (the Lit web components: <nc-chat-ui-app-provider> and friends)
//  - call:   @nexconn/call   (NCCallEngine: 1:1 and group voice/video calls over the same connection)
// Loaded on demand after sign-in, so it does not slow the first paint.
import * as chat from '@nexconn/chat';
import * as chatui from '@nexconn/chatui';
import * as call from '@nexconn/call';

export { chat, chatui, call };
