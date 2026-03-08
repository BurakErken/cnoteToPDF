import os
from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename
from parser import extract_and_parse_cnote
import uuid

app = Flask(__name__)

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
        
    if file and (file.filename.endswith('.cnote') or file.filename.endswith('.zip')):
        filename = secure_filename(file.filename)
        unique_id = str(uuid.uuid4())
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], f"{unique_id}_{filename}")
        file.save(filepath)
        
        extract_dir = os.path.join(app.config['UPLOAD_FOLDER'], unique_id)
        
        try:
            parsed_pages = extract_and_parse_cnote(filepath, extract_dir)
            return jsonify({
                'success': True,
                'message': 'File processed successfully',
                'pages': parsed_pages
            })
        except Exception as e:
            return jsonify({'error': str(e)}), 500
            
    return jsonify({'error': 'Invalid file type. Please upload a .cnote or .zip file.'}), 400

if __name__ == '__main__':
    app.run(debug=True, port=5000)
