

SUCCESS_HTML: str = (
    '<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;'
    'justify-content:center;height:100vh;font-family:sans-serif">'
    '<div style="text-align:center">'
    '<div style="width:64px;height:64px;border-radius:50%;background:#22c55e20;'
    'display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px">&#10003;</div>'
    '<h2 style="margin:0 0 8px">Connected!</h2>'
    '<p style="color:#888;margin:0">You can close this window</p>'
    '</div>'
    '<script>'
    'try{if(window.opener)window.opener.postMessage({type:"oauth_callback",data:{connected:true}},"*")}catch(e){}'
    'setTimeout(()=>window.close(),1500)'
    '</script>'
    '</body></html>'
)

ERROR_STYLE: str = (
    'style="background:#1a1a1a;color:#fff;display:flex;align-items:center;'
    'justify-content:center;height:100vh;font-family:sans-serif"'
)

