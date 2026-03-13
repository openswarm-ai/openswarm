import React from 'react';
import axios from 'axios';
import pushImg from '../../assets/color-reset.png'; // Adjust the path according to your project structure
import './ColorReset.css'; // Import the CSS file

const ColorReset = ({ projectStructure, setProjectStructure }) => {
    const pushStructure = async () => {
        try {
            console.log("Resetting colors");
            const response = await axios.post('http://127.0.0.1:6969/reset_color');
            console.log('Project structure:', response.data);
            setProjectStructure(response.data);
        } catch (error) {
            console.error('Error pushing project structure:', error);
        }
    };

    return (
        <div className="color-button-container">
            <div className="color-button-content">
                <button className="color-button" onClick={pushStructure}>
                    <img src={pushImg} alt="Project Structure" className="color-button-img" />
                </button>
                <p>Wipe colors</p>
            </div>
        </div>
    );
};

export default ColorReset;
