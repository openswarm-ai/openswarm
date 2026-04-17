from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from debugger_backend.project_scanner import update_debug_toggles, dir_to_output_format
import json
import os
NEEDS_RESYNC_FILE = os.path.join(os.path.dirname(__file__), 'needs_resync.txt')
DEBUG_TOGGLE_FILE = os.path.join(os.path.dirname(__file__), 'debug_toggles.json')
app = Flask(__name__)
CORS(app)

@app.route('/pull_structure', methods=['GET'])
def api_get_structure():
    print("GET /get_structure")
    scanned_dir=update_debug_toggles(save_to_file=True)
    # print("\n\nPS scanned_dir: ", scanned_dir)
    output = dir_to_output_format(scanned_dir)
    output = json.dumps(output, ensure_ascii=False, indent=4)
    # print("output: ", output)
    return Response(output, mimetype='application/json')

@app.route('/push_structure', methods=['POST'])
def api_push_structure():
    print("POST /push_structure")
    data = request.get_json()
    data = data['projectStructure']
    # print(data)
    with open(DEBUG_TOGGLE_FILE, 'w', encoding='utf-8') as file:
        json.dump(data, file, indent=4)
    with open(NEEDS_RESYNC_FILE, 'w') as f:
        f.write('1')
    return jsonify({"status": "success"})

@app.route('/reset_color', methods=['POST'])
def api_reset_color():
    print("POST /reset_color")
    scanned_dir=update_debug_toggles(save_to_file=False)
    scanned_dir.reset_colors()
    # print("RS: scanned_dir: ", scanned_dir)
    output = dir_to_output_format(scanned_dir)
    output = json.dumps(output, ensure_ascii=False, indent=4)
    # print("RS: output: ", output)
    return Response(output, mimetype='application/json')



if __name__ == '__main__':
    app.run(host='0.0.0.0', port=6969, debug=False)


