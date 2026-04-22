
import React from 'react';
import styles from './UnderConstruction.module.scss'; // CSS for styling the overlay

const UnderConstruction = () => {
    return (
        <div className={styles.under_construction_overlay}>
            <img src="/hammer-icon.png" alt="Console Icon" />
            <h2>Under Construction</h2>
            <p>This feature is coming soon!</p>
        </div>
    );
};

export { UnderConstruction };