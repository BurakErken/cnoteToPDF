import zipfile
import json
import base64
import struct
import os
import shutil

def find_images_recursive(data, images_list=None):
    if images_list is None:
        images_list = []
        
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, str) and (value.startswith('/9j/') or value.startswith('iVBORw')):
                img_data = {
                    'src': ('data:image/jpeg;base64,' if value.startswith('/9j/') else 'data:image/png;base64,') + value,
                    'x': 0, 'y': 0, 'width': 200, 'height': 200
                }
                
                # Try to extract normalize bounds (center, bound)
                bounds = data.get('bound')
                center = data.get('center')
                
                if bounds and isinstance(bounds, list) and len(bounds) == 2 and center and isinstance(center, list) and len(center) == 2:
                    try:
                        w = float(bounds[1][0])
                        h = float(bounds[1][1])
                        cx = float(center[0])
                        cy = float(center[1])
                        
                        img_data['rel_x'] = cx - (w / 2)
                        img_data['rel_y'] = cy - (h / 2)
                        img_data['rel_w'] = w
                        img_data['rel_h'] = h
                    except: pass
                
                # Fallbacks
                rect = data.get('rect')
                if rect and isinstance(rect, str):
                    try:
                        clean_rect = rect.replace('{', '').replace('}', '').split(',')
                        if len(clean_rect) >= 4:
                            img_data['x'] = float(clean_rect[0])
                            img_data['y'] = float(clean_rect[1])
                            img_data['width'] = float(clean_rect[2])
                            img_data['height'] = float(clean_rect[3])
                    except: pass
                elif rect and isinstance(rect, list) and len(rect) >= 4:
                    img_data['x'] = float(rect[0])
                    img_data['y'] = float(rect[1])
                    img_data['width'] = float(rect[2])
                    img_data['height'] = float(rect[3])
                else:
                    img_data['x'] = float(data.get('x', 0) or img_data['x'])
                    img_data['y'] = float(data.get('y', 0) or img_data['y'])
                    img_data['width'] = float(data.get('width', 200) or img_data['width'])
                    img_data['height'] = float(data.get('height', 200) or img_data['height'])
                
                images_list.append(img_data)
            else:
                find_images_recursive(value, images_list)
    elif isinstance(data, list):
        for item in data:
            find_images_recursive(item, images_list)
            
    return images_list

def parse_cpage(cpage_file):
    try:
        with open(cpage_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        images = find_images_recursive(data)
        strokes = data.get('_dkDrawing', [])
        all_points = []
        
        for stroke_b64 in strokes:
            try:
                binary_data = base64.b64decode(stroke_b64)
                i = 0
                while i < len(binary_data) - 9:
                    if binary_data[i] == 0x0D and binary_data[i+5] == 0x15:
                        x = struct.unpack('<f', binary_data[i+1:i+5])[0]
                        y = struct.unpack('<f', binary_data[i+6:i+10])[0]
                        
                        if -5000 < x < 5000 and -5000 < y < 5000:
                            all_points.append([round(x, 2), round(y, 2)])
                        i += 10
                    else:
                        i += 1
            except Exception:
                pass
        return {"points": all_points, "images": images}
    except Exception as e:
        print(f"Error parsing {cpage_file}: {e}")
        return {"points": [], "images": []}

def extract_and_parse_cnote(cnote_path, extract_dir):
    os.makedirs(extract_dir, exist_ok=True)
    
    try:
        with zipfile.ZipFile(cnote_path, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)
            
        pages = {}
        for filename in os.listdir(extract_dir):
            if filename.endswith(".cpage"):
                filepath = os.path.join(extract_dir, filename)
                parsed_data = parse_cpage(filepath)
                if parsed_data["points"] or parsed_data["images"]:
                    try:
                        page_num = int(filename.split('.')[0])
                    except ValueError:
                        page_num = filename
                    pages[filename] = {"num": page_num, "data": parsed_data}
                    
        sorted_pages = sorted(pages.items(), key=lambda x: x[1]["num"] if isinstance(x[1]["num"], int) else 9999)
        
        result = []
        for filename, item in sorted_pages:
            result.append({
                "filename": filename,
                "points": item["data"]["points"],
                "images": item["data"]["images"]
            })
            
        return result
    finally:
        # Clean up extracted files
        shutil.rmtree(extract_dir, ignore_errors=True)
        if os.path.exists(cnote_path):
            os.remove(cnote_path)
