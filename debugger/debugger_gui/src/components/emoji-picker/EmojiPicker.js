import React, { useState, useEffect } from "react";
import { emojiList } from '../../assets/emojis';
import PrevPage from '../../assets/prev-page.png';
import NextPage from '../../assets/next-page.png';
import './EmojiPicker.css'; // Import CSS file

const EMOJIS_PER_PAGE = 30;

const EmojiPicker = ({ defaultEmoji, handleEmojiChange }) => {
  const folderNames = Object.keys(emojiList); // Get all folder names
  const firstFolder = folderNames[0]; // Get the first folder name
  const [showPicker, setShowPicker] = useState(false);
  const [selectedEmoji, setSelectedEmoji] = useState(defaultEmoji || "😀"); // Initialize with the default emoji from props or fallback to smiley
  const [currentPage, setCurrentPage] = useState(0);
  const [currentFolder, setCurrentFolder] = useState(firstFolder); // Initialize with first folder

  // When defaultEmoji changes (e.g., from backend data), update selectedEmoji
  useEffect(() => {
    if (defaultEmoji) {
      setSelectedEmoji(defaultEmoji);
    }
  }, [defaultEmoji]);

  // Handle folder click
  const handleFolderClick = (folderName) => {
    setCurrentFolder(folderName); // Set the current folder
    setCurrentPage(0); // Reset page to 0 when switching folders
  };

  // Get the emojis for the selected folder
  const emojis = currentFolder ? emojiList[currentFolder] : [];
  const totalPages = Math.ceil(emojis.length / EMOJIS_PER_PAGE);
  const currentEmojis = emojis.slice(
    currentPage * EMOJIS_PER_PAGE,
    (currentPage + 1) * EMOJIS_PER_PAGE
  );

  const handleEmojiClick = (emoji) => {
    setSelectedEmoji(emoji);
    setShowPicker(false); // Close the picker when an emoji is selected
    handleEmojiChange(emoji); // Call the parent handler with the selected emoji
  };

  const togglePicker = () => {
    setShowPicker((prev) => !prev); // Toggle the picker visibility
  };

  const goToNextFolder = () => {
    const currentIndex = folderNames.indexOf(currentFolder);
    const nextFolderIndex = currentIndex + 1;
    if (nextFolderIndex < folderNames.length) {
      setCurrentFolder(folderNames[nextFolderIndex]);
      setCurrentPage(0); // Reset to the first page of the next folder
    }
  };

  const goToPreviousFolder = () => {
    const currentIndex = folderNames.indexOf(currentFolder);
    const previousFolderIndex = currentIndex - 1;
    if (previousFolderIndex >= 0) {
      const previousFolder = folderNames[previousFolderIndex];
      setCurrentFolder(previousFolder);
      const lastPageOfPreviousFolder = Math.ceil(emojiList[previousFolder].length / EMOJIS_PER_PAGE) - 1;
      setCurrentPage(lastPageOfPreviousFolder); // Set to the last page of the previous folder
    }
  };

  const goToNextPage = () => {
    if (currentPage < totalPages - 1) {
      setCurrentPage(currentPage + 1);
    } else {
      goToNextFolder();
    }
  };

  const goToPreviousPage = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
    } else {
      goToPreviousFolder();
    }
  };

  const isLastFolder = currentFolder === folderNames[folderNames.length - 1];
  const isLastPageOfLastFolder = isLastFolder && currentPage === totalPages - 1;
  const isFirstFolder = currentFolder === folderNames[0];
  const isFirstPageOfFirstFolder = isFirstFolder && currentPage === 0;

  return (
    <div className="picker-wrapper">
      {/* The emoji picker icon that changes when an emoji is selected */}
      <button onClick={togglePicker} className="picker-button">
        {selectedEmoji}
      </button>

      {/* Hoverable emoji picker */}
      {showPicker && (
        <div className="emoji-popup">
          <div className="emoji-section">
            <div className="pagination">
              <button onClick={goToPreviousPage} disabled={isFirstPageOfFirstFolder}>
                <img src={PrevPage} alt="Previous Page" />
              </button>
              <div className="emoji-grid">
                {currentEmojis.map((emoji, index) => (
                  <span
                    key={index}
                    className="emoji-item"
                    onClick={() => handleEmojiClick(emoji)}
                  >
                    {emoji}
                  </span>
                ))}
              </div>
              <button
                onClick={goToNextPage}
                disabled={isLastPageOfLastFolder}
              >
                <img src={NextPage} alt="Next Page" />
              </button>
            </div>
          </div>

          <div className="folder-section">
            {folderNames.map((folderName, index) => (
              <div
                key={index}
                className={`folder-item ${folderName === currentFolder ? 'active' : ''}`}
                onClick={() => handleFolderClick(folderName)}
              >
                {emojiList[folderName][0]}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;
