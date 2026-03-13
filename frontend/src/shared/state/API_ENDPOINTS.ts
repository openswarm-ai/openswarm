const is_local = true; // NOTE: Change this to false when deploying to production

const LOCAL_API_URL = 'http://localhost:8324/api';
const PROD_API_URL = 'https://your-domain.com/api';

// HEALTH - Endpoints
export const HEALTH_CHECK_URL = (is_local ? LOCAL_API_URL : PROD_API_URL) + '/health/check';

// ITEM DB - Endpoints
export const CREATE_ITEM_URL = (is_local ? LOCAL_API_URL : PROD_API_URL) + '/item_db/create';
export const LIST_ITEMS_URL = (is_local ? LOCAL_API_URL : PROD_API_URL) + '/item_db/list';
export const GET_ITEM_URL = (is_local ? LOCAL_API_URL : PROD_API_URL) + '/item_db/get';
export const UPDATE_ITEM_URL = (is_local ? LOCAL_API_URL : PROD_API_URL) + '/item_db/update';
export const DELETE_ITEM_URL = (is_local ? LOCAL_API_URL : PROD_API_URL) + '/item_db/delete';
